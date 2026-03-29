import asyncio
import json
import sys
from decimal import Decimal

from pyinjective.async_client_v2 import AsyncClient
from pyinjective.core.network import Network

def adjusted_margin(quantity: Decimal, margin: Decimal, is_long: bool, cumulative_funding_entry: Decimal, cumulative_funding: Decimal) -> Decimal:
    unrealized_funding_payment = (cumulative_funding - cumulative_funding_entry) * quantity * (-1 if is_long else 1)
    return margin + unrealized_funding_payment

async def main() -> None:
    # select network: local, testnet, mainnet
    network = Network.mainnet()

    # initialize grpc client
    client = AsyncClient(network)

    positions_per_market = dict()

    try:
        positions_dict = await client.fetch_chain_positions()
        total_positions = len(positions_dict.get('state', []))
        liquidable_positions = []

        for position in positions_dict["state"]:
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

                should_be_liquidated = (is_long and market_mark_price <= liquidation_price) or (not is_long and market_mark_price >= liquidation_price)

                if should_be_liquidated:
                    liquidable_position = {
                        "market_id": client_market.ticker,
                        "subaccount_id": position['subaccountId'],
                        "position_type": "Long" if is_long else "Short",
                        "liquidation_price": float(liquidation_price),
                        "mark_price": float(market_mark_price),
                        "maintenance_margin_ratio": float(client_market.maintenance_margin_ratio),
                        "quantity": float(quantity),
                        "entry_price": float(entry_price),
                        "margin": float(margin)
                    }
                    liquidable_positions.append(liquidable_position)

        # Output JSON result
        result = {
            "timestamp": int(asyncio.get_event_loop().time()),
            "total_positions": total_positions,
            "markets_processed": markets_processed,
            "checked_positions": checked_positions,
            "liquidable_count": len(liquidable_positions),
            "liquidable_positions": liquidable_positions
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
