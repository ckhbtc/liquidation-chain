import unittest
from decimal import Decimal
from unittest.mock import patch

from liquidation_monitor import (
    bankruptcy_price,
    fetch_position_trade_checks,
    is_position_bankrupt,
    LIQUIDATION_LOOKBACK_MS,
    position_key,
    position_equity,
)


class BankruptcyMathTest(unittest.TestCase):
    def test_long_position_is_bankrupt_below_bankruptcy_price(self):
        quantity = Decimal("1")
        entry_price = Decimal("10")
        adjusted_margin = Decimal("2")

        self.assertEqual(bankruptcy_price(quantity, entry_price, adjusted_margin, True), Decimal("8"))
        self.assertEqual(position_equity(adjusted_margin, quantity, entry_price, Decimal("8"), True), Decimal("0"))
        self.assertFalse(is_position_bankrupt(adjusted_margin, quantity, entry_price, Decimal("8"), True))
        self.assertTrue(is_position_bankrupt(adjusted_margin, quantity, entry_price, Decimal("7.5"), True))

    def test_short_position_is_bankrupt_above_bankruptcy_price(self):
        quantity = Decimal("1")
        entry_price = Decimal("10")
        adjusted_margin = Decimal("2")

        self.assertEqual(bankruptcy_price(quantity, entry_price, adjusted_margin, False), Decimal("12"))
        self.assertEqual(position_equity(adjusted_margin, quantity, entry_price, Decimal("12"), False), Decimal("0"))
        self.assertFalse(is_position_bankrupt(adjusted_margin, quantity, entry_price, Decimal("12"), False))
        self.assertTrue(is_position_bankrupt(adjusted_margin, quantity, entry_price, Decimal("12.5"), False))

    def test_position_key(self):
        self.assertEqual(position_key("subaccount-a", "market-a"), "subaccount-a:market-a")


class LiquidationConfirmationTest(unittest.IsolatedAsyncioTestCase):
    async def test_returns_trade_events_for_each_successful_lookup(self):
        calls = []

        class FakeIndexerClient:
            def __init__(self, network):
                self.network = network

            async def fetch_derivative_trades(self, **kwargs):
                calls.append(kwargs)
                return {
                    "trades": [
                        {
                            "tradeId": "trader-close-1",
                            "isLiquidation": False,
                            "positionDelta": {"tradeDirection": "buy"},
                        },
                        {
                            "tradeId": "liquidation-1",
                            "isLiquidation": True,
                            "positionDelta": {"tradeDirection": "sell"},
                        },
                    ]
                }

        with patch("liquidation_monitor.IndexerClient", FakeIndexerClient):
            checks = await fetch_position_trade_checks(object(), [{
                "key": "subaccount-a:market-a",
                "market_id": "market-a",
                "subaccount_id": "subaccount-a",
                "lastAlertTime": 1000,
                "lastTradeCheckTime": 2000,
            }])

        self.assertEqual(checks, {
            "subaccount-a:market-a": {
                "checked": True,
                "trades": [
                    {"id": "trader-close-1", "isLiquidation": False, "tradeDirection": "buy"},
                    {"id": "liquidation-1", "isLiquidation": True, "tradeDirection": "sell"},
                ],
            },
        })
        self.assertEqual(calls[0]["market_ids"], ["market-a"])
        self.assertEqual(calls[0]["subaccount_ids"], ["subaccount-a"])
        self.assertEqual(calls[0]["pagination"].start_time, max(0, 2000 - LIQUIDATION_LOOKBACK_MS))
        self.assertEqual(calls[0]["pagination"].limit, 100)

    async def test_returns_non_liquidation_trade_events(self):
        class FakeIndexerClient:
            def __init__(self, network):
                self.network = network

            async def fetch_derivative_trades(self, **kwargs):
                return {
                    "trades": [{
                        "tradeId": "trader-close-1",
                        "isLiquidation": False,
                        "positionDelta": {"tradeDirection": "buy"},
                    }]
                }

        with patch("liquidation_monitor.IndexerClient", FakeIndexerClient):
            checks = await fetch_position_trade_checks(object(), [{
                "key": "subaccount-a:market-a",
                "market_id": "market-a",
                "subaccount_id": "subaccount-a",
                "lastAlertTime": 1000,
            }])

        self.assertEqual(checks, {
            "subaccount-a:market-a": {
                "checked": True,
                "trades": [{"id": "trader-close-1", "isLiquidation": False, "tradeDirection": "buy"}],
            },
        })

    async def test_does_not_mark_failed_trade_lookup_as_checked(self):
        class FakeIndexerClient:
            def __init__(self, network):
                self.network = network

            async def fetch_derivative_trades(self, **kwargs):
                raise RuntimeError("indexer unavailable")

        with patch("liquidation_monitor.IndexerClient", FakeIndexerClient):
            checks = await fetch_position_trade_checks(object(), [{
                "key": "subaccount-a:market-a",
                "market_id": "market-a",
                "subaccount_id": "subaccount-a",
                "lastAlertTime": 1000,
            }])

        self.assertEqual(checks, {})


if __name__ == "__main__":
    unittest.main()
