import unittest
from decimal import Decimal

from liquidation_monitor import (
    bankruptcy_price,
    is_position_bankrupt,
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


if __name__ == "__main__":
    unittest.main()
