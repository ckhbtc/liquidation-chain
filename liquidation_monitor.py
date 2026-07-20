import asyncio
import json
import os
import sys
import time
from decimal import Decimal

from pyinjective.async_client_v2 import AsyncClient as ChainClient
from pyinjective.client.model.pagination import PaginationOption
from pyinjective.core.network import Network
from pyinjective.indexer_client import IndexerClient

LIQUIDATION_LOOKBACK_MS = 5 * 60 * 1000

def adjusted_margin(quantity: Decimal, margin: Decimal, is_long: bool, cumulative_funding_entry: Decimal, cumulative_funding: Decimal) -> Decimal:
    unrealized_funding_payment = (cumulative_funding - cumulative_funding_entry) * quantity * (-1 if is_long else 1)
    return margin + unrealized_funding_payment

def position_pnl(quantity: Decimal, entry_price: Decimal, mark_price: Decimal, is_long: bool) -> Decimal:
    if is_long:
        return quantity * (mark_price - entry_price)
    return quantity * (entry_price - mark_price)

def position_equity(adjusted_position_margin: Decimal, quantity: Decimal, entry_price: Decimal, mark_price: Decimal, is_long: bool) -> Decimal:
    return adjusted_position_margin + position_pnl(quantity, entry_price, mark_price, is_long)

def bankruptcy_price(quantity: Decimal, entry_price: Decimal, adjusted_position_margin: Decimal, is_long: bool) -> Decimal:
    if is_long:
        return entry_price - (adjusted_position_margin / quantity)
    return entry_price + (adjusted_position_margin / quantity)

def is_position_bankrupt(adjusted_position_margin: Decimal, quantity: Decimal, entry_price: Decimal, mark_price: Decimal, is_long: bool) -> bool:
    return position_equity(adjusted_position_margin, quantity, entry_price, mark_price, is_long) < Decimal(0)

def position_key(subaccount_id: str, market_id: str) -> str:
    return f"{subaccount_id}:{market_id}"

def load_alerted_position_checks() -> list[dict]:
    raw_checks = os.environ.get("ALERTED_POSITIONS_JSON", "[]")
    try:
        checks = json.loads(raw_checks)
        return checks if isinstance(checks, list) else []
    except json.JSONDecodeError:
        return []

async def fetch_confirmed_liquidated_position_keys(network: Network, alerted_position_checks: list[dict]) -> tuple[list[str], list[str]]:
    if not alerted_position_checks:
        return [], []

    now_ms = int(time.time() * 1000)
    indexer_client = IndexerClient(network)
    liquidated_keys = set()
    checked_keys = set()

    for check in alerted_position_checks:
        key = check.get("key")
        market_id = check.get("market_id")
        subaccount_id = check.get("subaccount_id")

        if not key or not market_id or not subaccount_id:
            continue

        try:
            last_alert_time = int(check.get("lastAlertTime") or 0)
        except (TypeError, ValueError):
            last_alert_time = 0

        start_time = max(0, last_alert_time - LIQUIDATION_LOOKBACK_MS)

        try:
            trades = await indexer_client.fetch_derivative_trades(
                market_ids=[market_id],
                subaccount_ids=[subaccount_id],
                pagination=PaginationOption(start_time=start_time, end_time=now_ms, limit=100),
            )
        except Exception:
            continue

        checked_keys.add(key)

        for trade in trades.get("trades", []):
            if trade.get("isLiquidation") is True:
                liquidated_keys.add(key)
                break

    return sorted(liquidated_keys), sorted(checked_keys)

async def main() -> None:
    # select network: local, testnet, mainnet
    network = Network.mainnet()

    # initialize grpc client
    client = ChainClient(network)

    positions_per_market = dict()

    try:
        alerted_position_checks = load_alerted_position_checks()
        confirmed_liquidated_position_keys, liquidation_check_succeeded_position_keys = await fetch_confirmed_liquidated_position_keys(network, alerted_position_checks)

        positions_dict = await client.fetch_chain_positions()
        total_positions = len(positions_dict.get('state', []))
        liquidable_positions = []
        open_positions = []

        for position in positions_dict["state"]:
            open_positions.append({
                "key": position_key(position["subaccountId"], position["marketId"]),
                "market_id": position["marketId"],
                "subaccount_id": position["subaccountId"],
                "position_type": "Long" if position["position"]["isLong"] else "Short",
            })

            if position["marketId"] not in positions_per_market:
                positions_per_market[position["marketId"]] = []
            positions_per_market[position["marketId"]].append(position)

        derivative_markets = await client.fetch_chain_derivative_markets(
            status="Active",
            market_ids=list(positions_per_market.keys()),
        )
        
        markets_processed = len(derivative_markets.get('markets', []))
        checked_positions = 0

        for market in derivative_markets["markets"]:
            client_market = (await client.all_derivative_markets())[market["market"]["marketId"]]
            market_mark_price = client_market._from_extended_chain_format(Decimal(market["markPrice"]))
            
            for position in positions_per_market[client_market.id]:
                checked_positions += 1
                is_long = position["position"]["isLong"]
                quantity = client_market._from_extended_chain_format(Decimal(position["position"]["quantity"]))
                entry_price = client_market._from_extended_chain_format(Decimal(position["position"]["entryPrice"]))
                margin = client_market._from_extended_chain_format(Decimal(position["position"]["margin"]))
                cumulative_funding_entry = client_market._from_extended_chain_format(Decimal(position["position"]["cumulativeFundingEntry"]))
                
                # Handle missing perpetualInfo gracefully
                try:
                    market_cumulative_funding = client_market._from_extended_chain_format(Decimal(market["perpetualInfo"]["fundingInfo"]["cumulativeFunding"]))
                except (KeyError, TypeError):
                    # Fallback to 0 if perpetualInfo is missing
                    market_cumulative_funding = Decimal(0)

                adj_margin = adjusted_margin(quantity, margin, is_long, cumulative_funding_entry, market_cumulative_funding)
                adjusted_unit_margin = (adj_margin / quantity) * (-1 if is_long else 1)
                maintenance_margin_ratio = client_market.maintenance_margin_ratio * (-1 if is_long else 1)

                liquidation_price = (entry_price + adjusted_unit_margin) / (Decimal(1) + maintenance_margin_ratio)
                bankrupt_price = bankruptcy_price(quantity, entry_price, adj_margin, is_long)
                equity = position_equity(adj_margin, quantity, entry_price, market_mark_price, is_long)
                is_bankrupt = is_position_bankrupt(adj_margin, quantity, entry_price, market_mark_price, is_long)

                should_be_liquidated = (is_long and market_mark_price <= liquidation_price) or (not is_long and market_mark_price >= liquidation_price)

                if should_be_liquidated:
                    liquidable_position = {
                        "market_id": client_market.id,
                        "market_ticker": client_market.ticker,
                        "subaccount_id": position['subaccountId'],
                        "position_type": "Long" if is_long else "Short",
                        "liquidation_price": float(liquidation_price),
                        "bankruptcy_price": float(bankrupt_price),
                        "mark_price": float(market_mark_price),
                        "maintenance_margin_ratio": float(client_market.maintenance_margin_ratio),
                        "quantity": float(quantity),
                        "entry_price": float(entry_price),
                        "margin": float(margin),
                        "equity": float(equity),
                        "is_bankrupt": is_bankrupt
                    }
                    liquidable_positions.append(liquidable_position)

        # Output JSON result
        result = {
            "timestamp": int(asyncio.get_event_loop().time()),
            "total_positions": total_positions,
            "markets_processed": markets_processed,
            "checked_positions": checked_positions,
            "liquidable_count": len(liquidable_positions),
            "liquidable_positions": liquidable_positions,
            "open_positions": open_positions,
            "confirmed_liquidated_position_keys": confirmed_liquidated_position_keys,
            "liquidation_check_succeeded_position_keys": liquidation_check_succeeded_position_keys
        }
        
        print(json.dumps(result, indent=2))
        
    except Exception as e:
        error_result = {
            "error": str(e),
            "timestamp": int(asyncio.get_event_loop().time())
        }
        print(json.dumps(error_result, indent=2))
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
