process.env.DRY_RUN = 'true';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_CHANNEL_ID = 'C123';
process.env.SLACK_USER_IDS = 'U111,U222';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildLiquidationAlertMessage,
    formatPositionLine,
    shouldMentionPositions
} = require('./liquidation-chain');

function position(overrides = {}) {
    return {
        market_id: 'NEAR/USDC PERP',
        market_ticker: 'NEAR/USDC PERP',
        subaccount_id: '0x90de5ac1987a9874ee868e703c4c6320548a316a',
        position_type: 'Long',
        quantity: 100,
        entry_price: 2.51,
        mark_price: 50,
        liquidation_price: 49,
        is_bankrupt: false,
        ...overrides
    };
}

test('low value non-bankrupt alerts do not mention users', () => {
    const lowRiskPosition = position({ quantity: 100, mark_price: 50 });

    assert.equal(shouldMentionPositions([lowRiskPosition]), false);

    const message = buildLiquidationAlertMessage([lowRiskPosition], true);
    const renderedBlocks = JSON.stringify(message.blocks);

    assert.doesNotMatch(message.text, /<@U111>|<@U222>|<!here>/);
    assert.doesNotMatch(renderedBlocks, /<@U111>|<@U222>|<!here>/);
});

test('alerts mention only configured users when total value at risk is over threshold', () => {
    const message = buildLiquidationAlertMessage([
        position({ quantity: 300, mark_price: 50 }),
        position({ market_id: 'BTC/USDC PERP', market_ticker: 'BTC/USDC PERP', quantity: 300, mark_price: 50 })
    ]);

    assert.match(message.text, /<@U111> <@U222>/);
    assert.doesNotMatch(message.text, /<!here>/);
});

test('bankrupt alerts mention configured users even below value threshold', () => {
    const bankruptPosition = position({ quantity: 10, mark_price: 50, is_bankrupt: true });

    assert.equal(shouldMentionPositions([bankruptPosition]), true);
    assert.match(formatPositionLine(bankruptPosition), /^BANKRUPT NEAR\/USDC PERP Long/);
});

test('compact position lines omit subaccount and liquidation price details', () => {
    const line = formatPositionLine(position());

    assert.match(line, /NEAR\/USDC PERP Long 100, risk \$5,000\.00, entry \$2\.51, mark \$50\.00/);
    assert.doesNotMatch(line, /Subaccount|Liquidation Price|0x90de5/);
});
