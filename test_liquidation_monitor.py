import unittest
from decimal import Decimal
from unittest.mock import patch

from liquidation_monitor import (
    bankruptcy_price,
    fetch_confirmed_liquidated_position_keys,
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
    async def test_confirms_keys_with_liquidation_trades(self):
        calls = []

        class FakeIndexerClient:
            def __init__(self, network):
                self.network = network

            async def fetch_derivative_trades(self, **kwargs):
                calls.append(kwargs)
                return {
                    "trades": [
                        {"isLiquidation": False},
                        {"isLiquidation": True},
                    ]
                }

        with patch("liquidation_monitor.IndexerClient", FakeIndexerClient):
            confirmed_keys, checked_keys = await fetch_confirmed_liquidated_position_keys(object(), [{
                "key": "subaccount-a:market-a",
                "market_id": "market-a",
                "subaccount_id": "subaccount-a",
                "lastAlertTime": 1000,
            }])

        self.assertEqual(confirmed_keys, ["subaccount-a:market-a"])
        self.assertEqual(checked_keys, ["subaccount-a:market-a"])
        self.assertEqual(calls[0]["market_ids"], ["market-a"])
        self.assertEqual(calls[0]["subaccount_ids"], ["subaccount-a"])
        self.assertEqual(calls[0]["pagination"].start_time, max(0, 1000 - LIQUIDATION_LOOKBACK_MS))
        self.assertEqual(calls[0]["pagination"].limit, 100)

    async def test_ignores_non_liquidation_trades(self):
        class FakeIndexerClient:
            def __init__(self, network):
                self.network = network

            async def fetch_derivative_trades(self, **kwargs):
                return {"trades": [{"isLiquidation": False}]}

        with patch("liquidation_monitor.IndexerClient", FakeIndexerClient):
            confirmed_keys, checked_keys = await fetch_confirmed_liquidated_position_keys(object(), [{
                "key": "subaccount-a:market-a",
                "market_id": "market-a",
                "subaccount_id": "subaccount-a",
                "lastAlertTime": 1000,
            }])

        self.assertEqual(confirmed_keys, [])
        self.assertEqual(checked_keys, ["subaccount-a:market-a"])

    async def test_does_not_mark_failed_trade_lookup_as_checked(self):
        class FakeIndexerClient:
            def __init__(self, network):
                self.network = network

            async def fetch_derivative_trades(self, **kwargs):
                raise RuntimeError("indexer unavailable")

        with patch("liquidation_monitor.IndexerClient", FakeIndexerClient):
            confirmed_keys, checked_keys = await fetch_confirmed_liquidated_position_keys(object(), [{
                "key": "subaccount-a:market-a",
                "market_id": "market-a",
                "subaccount_id": "subaccount-a",
                "lastAlertTime": 1000,
            }])

        self.assertEqual(confirmed_keys, [])
        self.assertEqual(checked_keys, [])


if __name__ == "__main__":
    unittest.main()
