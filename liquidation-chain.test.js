process.env.DRY_RUN = 'true';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_CHANNEL_ID = 'C123';
process.env.SLACK_USER_IDS = 'U111,U222';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ALERT_COOLDOWN_MS,
    buildLiquidationAlertMessage,
    buildResolvedAlertMessage,
    formatPositionLine,
    getAlertExitAction,
    getAlertCooldownMs,
    HOUSE_ALERT_COOLDOWN_MS,
    shouldMentionPositions,
    shouldSendFollowUp
} = require('./liquidation-chain');

const HOUSE_SUBACCOUNT_ID = '0x90de5ac1987a9874ae868e703c4c6320548a316a000000000000000000000000';

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
        bankruptcy_price: 48,
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
    assert.match(formatPositionLine(bankruptPosition), /^BANKRUPT NEAR Long/);
});

test('compact position lines omit subaccount, use base asset, and include liquidation and bankruptcy prices', () => {
    const line = formatPositionLine(position());

    assert.match(line, /NEAR Long 100, risk \$5,000\.00, entry \$2\.51, mark \$50\.00, liq \$49\.00, bkr \$48\.00/);
    assert.doesNotMatch(line, /\/USDC PERP|Subaccount|0x90de5/);
});

test('single-position alerts omit the header block and redundant summary', () => {
    const message = buildLiquidationAlertMessage([position()]);
    const blockText = message.blocks[0].text.text;

    assert.equal(message.blocks.length, 1);
    assert.equal(message.blocks[0].type, 'section');
    assert.doesNotMatch(blockText, /Liquidatable position|1 position, \$5,000\.00 at risk/);
    assert.match(blockText, /^NEAR Long 100, risk \$5,000\.00/);
});

test('house account positions are tagged with a house emoji', () => {
    const line = formatPositionLine(position({ subaccount_id: HOUSE_SUBACCOUNT_ID }));

    assert.match(line, /^🏠 NEAR Long/);
});

test('non-bankrupt house account follow-ups use a two-hour cooldown', () => {
    const housePosition = position({ subaccount_id: HOUSE_SUBACCOUNT_ID });

    assert.equal(getAlertCooldownMs(housePosition), HOUSE_ALERT_COOLDOWN_MS);
    assert.equal(shouldSendFollowUp(housePosition, {
        lastAlertTime: 0,
        position: housePosition
    }, HOUSE_ALERT_COOLDOWN_MS - 1), false);
    assert.equal(shouldSendFollowUp(housePosition, {
        lastAlertTime: 0,
        position: housePosition
    }, HOUSE_ALERT_COOLDOWN_MS), true);
});

test('house account bankruptcy bypasses the two-hour cooldown', () => {
    const previousHousePosition = position({ subaccount_id: HOUSE_SUBACCOUNT_ID, is_bankrupt: false });
    const bankruptHousePosition = position({ subaccount_id: HOUSE_SUBACCOUNT_ID, is_bankrupt: true });

    assert.equal(getAlertCooldownMs(bankruptHousePosition), ALERT_COOLDOWN_MS);
    assert.equal(shouldSendFollowUp(bankruptHousePosition, {
        lastAlertTime: 0,
        position: previousHousePosition
    }, 1), true);
});

test('open positions that stop being liquidatable are retained without resolved alert', () => {
    const key = 'subaccount-a:market-a';
    const action = getAlertExitAction(key, {
        currentLiquidatableKeys: new Set(),
        currentOpenPositionKeys: new Set([key]),
        confirmedLiquidatedKeys: new Set()
    });

    assert.equal(action, 'retain');
});

test('resolved alerts require confirmed liquidation', () => {
    const key = 'subaccount-a:market-a';

    assert.equal(getAlertExitAction(key, {
        currentLiquidatableKeys: new Set(),
        currentOpenPositionKeys: new Set(),
        confirmedLiquidatedKeys: new Set()
    }), 'clear');

    assert.equal(getAlertExitAction(key, {
        currentLiquidatableKeys: new Set(),
        currentOpenPositionKeys: new Set(),
        confirmedLiquidatedKeys: new Set([key])
    }), 'resolved');
});

test('resolved alerts render as one compact line', () => {
    const message = buildResolvedAlertMessage([position()]);

    assert.equal(message.blocks.length, 1);
    assert.equal(message.blocks[0].type, 'section');
    assert.equal(message.blocks[0].text.text, '1 position resolved: NEAR Long');
    assert.doesNotMatch(message.blocks[0].text.text, /\n|Positions resolved/);
});
