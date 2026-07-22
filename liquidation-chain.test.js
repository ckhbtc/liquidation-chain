process.env.DRY_RUN = 'true';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_CHANNEL_ID = 'C123';
process.env.SLACK_USER_IDS = 'U111,U222';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ALERT_COOLDOWN_MS,
    buildLiquidationAlertMessage,
    buildIncidentProgressAlertMessage,
    buildPositionOutcomeAlertMessage,
    formatPositionLine,
    getAlertExitAction,
    mergeIncidentTradeEvents,
    processAlerts,
    shouldSendIncidentProgress,
    UNCONFIRMED_EXIT_RETENTION_MS,
    shouldMentionPositions,
    shouldSendUnconfirmedOutcome
} = require('./liquidation-chain');
const { alertedPositions } = require('./liquidation-chain');

const HOUSE_SUBACCOUNT_IDS = [
    '0x90de5ac1987a9874ae868e703c4c6320548a316a000000000000000000000000',
    '0x93073bf6ed84f9093f96f525da6cb859776b75d6000000000000000000000000'
];

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
    for (const subaccountId of HOUSE_SUBACCOUNT_IDS) {
        const line = formatPositionLine(position({ subaccount_id: subaccountId }));

        assert.match(line, /^🏠 NEAR Long/);
    }
});

test('open positions that stop being liquidatable are marked as risk cleared', () => {
    const key = 'subaccount-a:market-a';
    const action = getAlertExitAction(key, {
        currentLiquidatableKeys: new Set(),
        currentOpenPositionKeys: new Set([key]),
        confirmedLiquidatedKeys: new Set(),
        liquidationCheckSucceededKeys: new Set([key])
    });

    assert.equal(action, 'risk-cleared');
});

test('position exits wait for a failed liquidation lookup', () => {
    const key = 'subaccount-a:market-a';
    const action = getAlertExitAction(key, {
        currentLiquidatableKeys: new Set(),
        currentOpenPositionKeys: new Set([key]),
        confirmedLiquidatedKeys: new Set(),
        liquidationCheckSucceededKeys: new Set()
    });

    assert.equal(action, 'retry');
});

test('non-liquidation outcomes wait for the confirmation window', () => {
    const now = 1_000_000;

    assert.equal(shouldSendUnconfirmedOutcome({}, now), false);
    assert.equal(shouldSendUnconfirmedOutcome({ inactiveSince: now - UNCONFIRMED_EXIT_RETENTION_MS + 1 }, now), false);
    assert.equal(shouldSendUnconfirmedOutcome({ inactiveSince: now - UNCONFIRMED_EXIT_RETENTION_MS }, now), true);
});

test('position exit actions distinguish liquidation from closure', () => {
    const key = 'subaccount-a:market-a';

    assert.equal(getAlertExitAction(key, {
        currentLiquidatableKeys: new Set(),
        currentOpenPositionKeys: new Set(),
        confirmedLiquidatedKeys: new Set(),
        liquidationCheckSucceededKeys: new Set([key])
    }), 'closed-by-trader');

    assert.equal(getAlertExitAction(key, {
        currentLiquidatableKeys: new Set(),
        currentOpenPositionKeys: new Set(),
        confirmedLiquidatedKeys: new Set([key])
    }), 'fully-liquidated');

    assert.equal(getAlertExitAction(key, {
        currentLiquidatableKeys: new Set(),
        currentOpenPositionKeys: new Set([key]),
        confirmedLiquidatedKeys: new Set([key])
    }), 'risk-cleared');
});

test('confirmed liquidation alerts render as one compact line', () => {
    const message = buildPositionOutcomeAlertMessage('fully-liquidated', [position()]);

    assert.equal(message.blocks.length, 1);
    assert.equal(message.blocks[0].type, 'section');
    assert.equal(message.blocks[0].text.text, '1 position fully liquidated: NEAR Long');
    assert.doesNotMatch(message.blocks[0].text.text, /\n|Positions resolved|resolved/);
});

test('risk-cleared and closed alerts use distinct messages', () => {
    const riskCleared = buildPositionOutcomeAlertMessage('risk-cleared', [position()]);
    const closed = buildPositionOutcomeAlertMessage('closed-by-trader', [position()]);

    assert.equal(riskCleared.blocks[0].text.text, '1 position risk cleared, remains open: NEAR Long');
    assert.equal(closed.blocks[0].text.text, '1 position closed by trader: NEAR Long');
});

test('open incidents send one non-mention progress update every 30 minutes', () => {
    const now = 1_000_000;
    const incident = { lastProgressAlertTime: now - ALERT_COOLDOWN_MS };

    assert.equal(shouldSendIncidentProgress(incident, now), true);
    assert.equal(shouldSendIncidentProgress({ lastProgressAlertTime: now - ALERT_COOLDOWN_MS + 1 }, now), false);

    const message = buildIncidentProgressAlertMessage('partial-liquidation', [position()]);
    assert.equal(message.blocks[0].text.text, '1 partial liquidation in progress: NEAR Long 100 remaining, risk $5,000.00');
    assert.doesNotMatch(JSON.stringify(message), /<@U111>|<@U222>|<!here>/);
});

test('incident trade events are deduplicated and classify liquidations separately from trader reductions', () => {
    const initial = {
        position: position({ position_type: 'Short' }),
        seenTradeIds: []
    };
    const tradeCheck = {
        checked: true,
        trades: [
            { id: 'liq-1', isLiquidation: true, tradeDirection: 'sell' },
            { id: 'trader-close-1', isLiquidation: false, tradeDirection: 'buy' }
        ]
    };

    const updated = mergeIncidentTradeEvents(initial, tradeCheck, 2_000);

    assert.deepEqual(updated.seenTradeIds, ['liq-1', 'trader-close-1']);
    assert.equal(updated.hadLiquidation, true);
    assert.equal(updated.hadTraderReduction, true);
    assert.equal(updated.lastTradeCheckTime, 2_000);

    const deduplicated = mergeIncidentTradeEvents(updated, tradeCheck, 3_000);
    assert.deepEqual(deduplicated.seenTradeIds, ['liq-1', 'trader-close-1']);
    assert.equal(deduplicated.lastTradeCheckTime, 3_000);
});

test('a partial liquidation keeps the same incident open without a second initial alert', async () => {
    const now = 2_000_000;
    const atRisk = position();
    const key = `${atRisk.subaccount_id}:${atRisk.market_id}`;
    const originalNow = Date.now;
    const originalLog = console.log;

    alertedPositions.clear();
    alertedPositions.set(key, {
        lastAlertTime: now - 60_000,
        lastProgressAlertTime: now - 60_000,
        lastTradeCheckTime: now - 60_000,
        position: atRisk,
        seenTradeIds: [],
        hadLiquidation: false,
        hadTraderReduction: false
    });
    Date.now = () => now;
    console.log = () => {};

    try {
        await processAlerts([atRisk], [atRisk], {
            [key]: {
                checked: true,
                trades: [{ id: 'partial-liquidation-1', isLiquidation: true, tradeDirection: 'sell' }]
            }
        });

        const incident = alertedPositions.get(key);
        assert.ok(incident);
        assert.equal(incident.lastAlertTime, now - 60_000);
        assert.equal(incident.hadLiquidation, true);
        assert.deepEqual(incident.seenTradeIds, ['partial-liquidation-1']);
    } finally {
        Date.now = originalNow;
        console.log = originalLog;
        alertedPositions.clear();
    }
});
