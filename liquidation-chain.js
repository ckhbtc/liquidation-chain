require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');

const app = express();
const PORT = 16000;

// Dry run mode - can be enabled via command line or environment variable
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

// Slack configuration
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const SLACK_USER_IDS = (process.env.SLACK_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

// Alert configuration
const MIN_VALUE_AT_RISK = 1; // Minimum $1 value at risk to send alert
const MENTION_VALUE_AT_RISK_USD = 25000;
const MAX_ALERT_POSITIONS = 10;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between incident progress updates
const UNCONFIRMED_EXIT_RETENTION_MS = 30 * 60 * 1000; // Keep checking briefly for delayed liquidation trades
const MAX_SEEN_TRADE_IDS = 200;
const HOUSE_SUBACCOUNT_IDS = new Set([
    '0x90de5ac1987a9874ae868e703c4c6320548a316a000000000000000000000000',
    '0x93073bf6ed84f9093f96f525da6cb859776b75d6000000000000000000000000'
]);
const DATA_DIR = path.join(__dirname, 'data');
const ALERT_STATE_FILE = path.join(DATA_DIR, 'alert-state.json');

// Initialize Slack client (only if not in dry run mode)
const slack = DRY_RUN ? null : new WebClient(SLACK_BOT_TOKEN);

// Track alert incidents: Map<positionKey, {lastAlertTime, lastProgressAlertTime, position, seenTradeIds, hadLiquidation, hadTraderReduction, inactiveSince?}>
const alertedPositions = new Map();

function loadAlertState() {
    try {
        if (!fs.existsSync(ALERT_STATE_FILE)) return;

        const entries = JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf8'));
        if (!Array.isArray(entries)) return;

        for (const [key, data] of entries) {
            if (key && data?.lastAlertTime && data?.position) {
                alertedPositions.set(key, data);
            }
        }
    } catch (error) {
        console.error(`[${getTimestamp()}] ⚠️ Failed to load alert state:`, error.message);
    }
}

function saveAlertState() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify([...alertedPositions.entries()], null, 2));
    } catch (error) {
        console.error(`[${getTimestamp()}] ⚠️ Failed to save alert state:`, error.message);
    }
}

function getAlertedPositionChecks() {
    return [...alertedPositions.entries()].map(([key, data]) => ({
        key,
        lastAlertTime: data.lastAlertTime,
        lastTradeCheckTime: data.lastTradeCheckTime || data.lastAlertTime,
        market_id: data.position?.market_id,
        subaccount_id: data.position?.subaccount_id,
        position_type: data.position?.position_type
    })).filter(check => check.market_id && check.subaccount_id);
}

function shouldSendUnconfirmedOutcome(data, now) {
    return Boolean(data.inactiveSince) && now - data.inactiveSince >= UNCONFIRMED_EXIT_RETENTION_MS;
}

function shouldSendIncidentProgress(data, now) {
    const lastUpdate = data.lastProgressAlertTime || data.lastAlertTime;
    return now - lastUpdate >= ALERT_COOLDOWN_MS;
}

// Helper function to get formatted timestamp
function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Helper function to create a unique key for a position
function getPositionKey(position) {
    return `${position.subaccount_id}:${position.market_id}`;
}

function getPositionKeySet(positions) {
    return new Set(positions.map(getPositionKey));
}

function getAlertExitAction(key, {
    currentLiquidatableKeys,
    currentOpenPositionKeys,
    confirmedLiquidatedKeys,
    liquidationCheckSucceededKeys = new Set()
}) {
    if (currentLiquidatableKeys.has(key)) {
        return 'active';
    }

    if (confirmedLiquidatedKeys.has(key)) {
        return currentOpenPositionKeys.has(key) ? 'risk-cleared' : 'fully-liquidated';
    }

    if (!liquidationCheckSucceededKeys.has(key)) {
        return 'retry';
    }

    if (currentOpenPositionKeys.has(key)) {
        return 'risk-cleared';
    }

    return 'closed-by-trader';
}

function isTraderReduction(position, trade) {
    if (trade.isLiquidation) return false;

    const direction = String(trade.tradeDirection || '').toLowerCase();
    return (position.position_type === 'Long' && direction === 'sell') ||
        (position.position_type === 'Short' && direction === 'buy');
}

function mergeIncidentTradeEvents(data, tradeCheck, now) {
    if (!tradeCheck?.checked) return data;

    const seenTradeIds = new Set(Array.isArray(data.seenTradeIds) ? data.seenTradeIds : []);
    let hadLiquidation = Boolean(data.hadLiquidation);
    let hadTraderReduction = Boolean(data.hadTraderReduction);

    for (const trade of tradeCheck.trades || []) {
        const tradeId = trade?.id || trade?.tradeId;
        if (!tradeId || seenTradeIds.has(tradeId)) continue;

        seenTradeIds.add(tradeId);
        hadLiquidation = hadLiquidation || trade.isLiquidation === true;
        hadTraderReduction = hadTraderReduction || isTraderReduction(data.position, trade);
    }

    return {
        ...data,
        seenTradeIds: [...seenTradeIds].slice(-MAX_SEEN_TRADE_IDS),
        hadLiquidation,
        hadTraderReduction,
        lastTradeCheckTime: now
    };
}

// Helper function to calculate value at risk for a position
function getValueAtRisk(position) {
    return position.quantity * position.mark_price;
}

function getTotalValueAtRisk(positions) {
    return positions.reduce((sum, pos) => sum + getValueAtRisk(pos), 0);
}

function formatUsd(value) {
    return Number(value || 0).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatPrice(value) {
    const numericValue = Number(value || 0);
    const maxDigits = Math.abs(numericValue) >= 1 ? 2 : 6;
    return `$${numericValue.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: maxDigits
    })}`;
}

function formatAmount(value) {
    return Number(value || 0).toLocaleString('en-US', {
        maximumFractionDigits: 4
    });
}

function getMarketDisplay(position) {
    return position.market_ticker || position.market_id;
}

function getBaseAssetDisplay(position) {
    const marketDisplay = String(getMarketDisplay(position) || '');
    const [baseAsset] = marketDisplay.split('/');
    return (baseAsset || marketDisplay).trim();
}

function isBankruptPosition(position) {
    return position.is_bankrupt === true;
}

function isHouseAccount(position) {
    return HOUSE_SUBACCOUNT_IDS.has(String(position.subaccount_id || '').toLowerCase());
}

function getUserMentions() {
    return SLACK_USER_IDS.map(userId => `<@${userId}>`).join(' ');
}

function shouldMentionPositions(positions) {
    return getTotalValueAtRisk(positions) > MENTION_VALUE_AT_RISK_USD ||
        positions.some(isBankruptPosition);
}

function formatPositionLine(position) {
    const bankruptPrefix = isBankruptPosition(position) ? 'BANKRUPT ' : '';
    const housePrefix = isHouseAccount(position) ? '🏠 ' : '';
    return `${bankruptPrefix}${housePrefix}${getBaseAssetDisplay(position)} ${position.position_type} ${formatAmount(position.quantity)}, ` +
        `risk ${formatUsd(getValueAtRisk(position))}, entry ${formatPrice(position.entry_price)}, ` +
        `mark ${formatPrice(position.mark_price)}, liq ${formatPrice(position.liquidation_price)}, ` +
        `bkr ${formatPrice(position.bankruptcy_price)}`;
}

function buildLiquidationAlertMessage(liquidablePositions) {
    const totalValueAtRisk = getTotalValueAtRisk(liquidablePositions);
    const shouldMention = shouldMentionPositions(liquidablePositions);
    const userMentions = shouldMention ? getUserMentions() : '';
    const summary = `${liquidablePositions.length} position${liquidablePositions.length === 1 ? '' : 's'}, ${formatUsd(totalValueAtRisk)} at risk`;
    const shownPositions = liquidablePositions.slice(0, MAX_ALERT_POSITIONS);
    const positionLines = shownPositions.map(formatPositionLine);
    const hiddenCount = liquidablePositions.length - shownPositions.length;

    if (hiddenCount > 0) {
        positionLines.push(`+${hiddenCount} more`);
    }

    const detailsText = [
        userMentions,
        liquidablePositions.length > 1 ? `*${summary}*` : '',
        positionLines.join('\n')
    ].filter(Boolean).join('\n');

    return {
        channel: SLACK_CHANNEL_ID,
        text: `${userMentions ? `${userMentions} ` : ''}${liquidablePositions.length > 1 ? summary : positionLines[0]}`,
        mrkdwn: true,
        link_names: true,
        unfurl_links: false,
        unfurl_media: false,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: detailsText
                }
            }
        ]
    };
}

function getIncidentProgressAlertText(kind, positions) {
    const labels = {
        'partial-liquidation': ['partial liquidation in progress', 'partial liquidations in progress'],
        'risk-persists': ['liquidation risk persists', 'liquidation risks persist']
    };
    const label = labels[kind];

    if (!label) {
        throw new Error(`Unknown incident progress kind: ${kind}`);
    }

    const shownPositions = positions.slice(0, MAX_ALERT_POSITIONS);
    const positionLines = shownPositions.map(pos => `${getBaseAssetDisplay(pos)} ${pos.position_type} ${formatAmount(pos.quantity)} remaining, risk ${formatUsd(getValueAtRisk(pos))}`);
    const hiddenCount = positions.length - shownPositions.length;

    if (hiddenCount > 0) {
        positionLines.push(`+${hiddenCount} more`);
    }

    return `${positions.length} ${positions.length === 1 ? label[0] : label[1]}: ${positionLines.join(', ')}`;
}

function buildIncidentProgressAlertMessage(kind, positions) {
    const progressText = getIncidentProgressAlertText(kind, positions);

    return {
        channel: SLACK_CHANNEL_ID,
        text: progressText,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: progressText
                }
            }
        ]
    };
}

// Helper function to get ticker from market ID
async function getTickerFromMarketId(marketId) {
    try {
        const response = await axios.get(`https://sentry.lcd.injective.network/injective/exchange/v1beta1/derivative/markets/${marketId}`);
        return response.data.market.market.ticker || marketId;
    } catch (error) {
        console.error(`[${getTimestamp()}] ⚠️ Failed to get ticker for market ${marketId}:`, error.message);
        return marketId; // Fallback to market ID if ticker lookup fails
    }
}

// Helper function to enrich positions with tickers
async function enrichPositionsWithTickers(positions) {
    const enrichedPositions = [];

    for (const position of positions) {
        if (position.market_ticker) {
            enrichedPositions.push(position);
            continue;
        }

        const ticker = await getTickerFromMarketId(position.market_id);
        enrichedPositions.push({
            ...position,
            market_ticker: ticker
        });
    }

    return enrichedPositions;
}

app.use(express.json());

let latestResults = {
    lastCheck: null,
    liquidablePositions: [],
    openPositions: [],
    positionTradeChecks: {},
    status: 'starting',
    error: null
};

async function sendSlackAlert(liquidablePositions) {
    if (liquidablePositions.length === 0) return;

    // In dry run mode, print to console instead of sending to Slack
    if (DRY_RUN) {
        printAlertToConsole(liquidablePositions);
        return;
    }

    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) return;

    const message = buildLiquidationAlertMessage(liquidablePositions);

    try {
        const result = await slack.chat.postMessage(message);
        console.log(`[${getTimestamp()}] ✅ Slack alert sent for ${liquidablePositions.length} positions to ${result.channel}`);
    } catch (error) {
        console.error(`[${getTimestamp()}] ❌ Slack alert failed:`, error.message);
    }
}

async function sendPositionOutcomeAlert(outcome, positions) {
    if (positions.length === 0) return;

    const outcomeText = getPositionOutcomeAlertText(outcome, positions);

    // In dry run mode, print to console instead of sending to Slack
    if (DRY_RUN) {
        console.log('\n' + '='.repeat(60));
        console.log(`[${getTimestamp()}] POSITION OUTCOME: ${outcome} (DRY RUN MODE)`);
        console.log('='.repeat(60));
        console.log(outcomeText);
        console.log('='.repeat(60) + '\n');
        return;
    }

    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) return;

    const message = buildPositionOutcomeAlertMessage(outcome, positions);

    try {
        const result = await slack.chat.postMessage(message);
        console.log(`[${getTimestamp()}] ✅ ${outcome} alert sent for ${positions.length} positions to ${result.channel}`);
    } catch (error) {
        console.error(`[${getTimestamp()}] ❌ ${outcome} alert failed:`, error.message);
    }
}

async function sendIncidentProgressAlert(kind, positions) {
    if (positions.length === 0) return;

    const progressText = getIncidentProgressAlertText(kind, positions);

    if (DRY_RUN) {
        console.log(`[${getTimestamp()}] INCIDENT PROGRESS: ${progressText}`);
        return;
    }

    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) return;

    try {
        const result = await slack.chat.postMessage(buildIncidentProgressAlertMessage(kind, positions));
        console.log(`[${getTimestamp()}] ✅ ${kind} update sent for ${positions.length} positions to ${result.channel}`);
    } catch (error) {
        console.error(`[${getTimestamp()}] ❌ ${kind} update failed:`, error.message);
    }
}

function getPositionOutcomeAlertText(outcome, positions) {
    const labels = {
        'fully-liquidated': ['position fully liquidated', 'positions fully liquidated'],
        'risk-cleared': ['position risk cleared, remains open', 'positions risk cleared, remain open'],
        'closed-by-trader': ['position closed by trader', 'positions closed by trader']
    };
    const label = labels[outcome];

    if (!label) {
        throw new Error(`Unknown position outcome: ${outcome}`);
    }

    const shownPositions = positions.slice(0, MAX_ALERT_POSITIONS);
    const positionLines = shownPositions.map(pos => `${getBaseAssetDisplay(pos)} ${pos.position_type}`);
    const hiddenCount = positions.length - shownPositions.length;

    if (hiddenCount > 0) {
        positionLines.push(`+${hiddenCount} more`);
    }

    return `${positions.length} ${positions.length === 1 ? label[0] : label[1]}: ${positionLines.join(', ')}`;
}

function buildPositionOutcomeAlertMessage(outcome, positions) {
    const outcomeText = getPositionOutcomeAlertText(outcome, positions);

    return {
        channel: SLACK_CHANNEL_ID,
        text: outcomeText,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: outcomeText
                }
            }
        ]
    };
}

function printAlertToConsole(liquidablePositions) {
    const totalValueAtRisk = getTotalValueAtRisk(liquidablePositions);
    const shouldMention = shouldMentionPositions(liquidablePositions);
    const summary = `${liquidablePositions.length} position${liquidablePositions.length === 1 ? '' : 's'}, ${formatUsd(totalValueAtRisk)} at risk`;

    console.log('\n' + '='.repeat(60));
    console.log(`[${getTimestamp()}] DRY RUN MODE`);
    console.log('='.repeat(60));

    if (liquidablePositions.length > 1) {
        console.log(summary);
        console.log('');
    }

    liquidablePositions.slice(0, MAX_ALERT_POSITIONS).forEach((pos) => {
        console.log(formatPositionLine(pos));
    });

    if (liquidablePositions.length > MAX_ALERT_POSITIONS) {
        console.log(`+${liquidablePositions.length - MAX_ALERT_POSITIONS} more`);
    }

    console.log('');
    console.log(shouldMention ? `Would mention: ${SLACK_USER_IDS.join(', ')}` : 'Would not mention users');
    console.log(`Would post to channel: ${SLACK_CHANNEL_ID}`);
    console.log('='.repeat(60) + '\n');
}

function runLiquidationCheck() {
    return new Promise((resolve) => {
        console.log(`[${getTimestamp()}] 🔍 Running liquidation check...`);

        const pythonScript = path.join(__dirname, 'liquidation_monitor.py');
        const venvPython = path.join(__dirname, 'liquidation-env', 'bin', 'python');

        // In dry run mode, always use system python3, otherwise prefer virtual environment
        const pythonCmd = DRY_RUN ? 'python3' : (require('fs').existsSync(venvPython) ? `"${venvPython}"` : 'python3');
        const alertedPositionsJson = JSON.stringify(getAlertedPositionChecks());

        exec(`${pythonCmd} "${pythonScript}"`, {
            timeout: 60000,
            env: {
                ...process.env,
                ALERTED_POSITIONS_JSON: alertedPositionsJson
            }
        }, (error, stdout, stderr) => {
            const timestamp = new Date().toISOString();

            if (error) {
                console.error(`[${getTimestamp()}] ❌ Error:`, error);
                latestResults = {
                    lastCheck: timestamp,
                    liquidablePositions: [],
                    status: 'error',
                    error: error.message
                };
                resolve(latestResults);
                return;
            }

            try {
                const results = JSON.parse(stdout);

                latestResults = {
                    lastCheck: timestamp,
                    liquidablePositions: results.liquidable_positions || [],
                    openPositions: results.open_positions || [],
                    positionTradeChecks: results.position_trade_checks || {},
                    totalPositions: results.total_positions,
                    status: 'healthy',
                    error: null
                };

                console.log(`[${getTimestamp()}] ✅ Check complete: ${results.liquidable_count || 0} liquidable positions`);

                // Process alerts with throttling and resolved detection
                processAlerts(
                    results.liquidable_positions || [],
                    results.open_positions || [],
                    results.position_trade_checks || {}
                );
            } catch (parseError) {
                console.error(`[${getTimestamp()}] ❌ Parse error:`, parseError);
                latestResults = {
                    lastCheck: timestamp,
                    liquidablePositions: [],
                    status: 'error',
                    error: 'Parse error'
                };
            }

            resolve(latestResults);
        });
    });
}

// Routes
app.get('/', (req, res) => {
    res.json({
        service: 'Injective Liquidation Monitor',
        status: latestResults.status,
        lastCheck: latestResults.lastCheck,
        liquidableCount: latestResults.liquidablePositions.length,
        uptime: process.uptime()
    });
});

app.get('/status', (req, res) => {
    res.json(latestResults);
});

app.post('/check-now', async (req, res) => {
    const results = await runLiquidationCheck();
    res.json(results);
});

app.get('/health', (req, res) => {
    const isHealthy = latestResults.status !== 'error';
    res.status(isHealthy ? 200 : 503).json({
        healthy: isHealthy,
        status: latestResults.status,
        lastCheck: latestResults.lastCheck
    });
});

// Process alerts with throttling and outcome detection
async function processAlerts(
    currentLiquidablePositions,
    currentOpenPositions = [],
    positionTradeChecks = {}
) {
    const now = Date.now();

    // Enrich positions with tickers first
    let enrichedPositions = [];
    try {
        enrichedPositions = await enrichPositionsWithTickers(currentLiquidablePositions);
    } catch (error) {
        console.error(`[${getTimestamp()}] ❌ Failed to enrich positions with tickers:`, error);
        enrichedPositions = currentLiquidablePositions;
    }

    // Filter positions by minimum value at risk
    const significantPositions = enrichedPositions.filter(pos => getValueAtRisk(pos) >= MIN_VALUE_AT_RISK);

    const currentPositionKeys = getPositionKeySet(significantPositions);
    const currentOpenPositionKeys = getPositionKeySet(currentOpenPositions);
    const currentPositionsByKey = new Map(significantPositions.map(pos => [getPositionKey(pos), pos]));

    const outcomePositions = {
        'fully-liquidated': [],
        'risk-cleared': [],
        'closed-by-trader': []
    };
    const progressPositions = {
        'partial-liquidation': [],
        'risk-persists': []
    };

    for (const [key, savedData] of alertedPositions.entries()) {
        const tradeCheck = positionTradeChecks[key];
        const data = mergeIncidentTradeEvents(savedData, tradeCheck, now);
        const confirmedLiquidatedKeys = data.hadLiquidation ? new Set([key]) : new Set();
        const liquidationCheckSucceededKeys = tradeCheck?.checked ? new Set([key]) : new Set();
        const exitAction = getAlertExitAction(key, {
            currentLiquidatableKeys: currentPositionKeys,
            currentOpenPositionKeys,
            confirmedLiquidatedKeys,
            liquidationCheckSucceededKeys
        });

        if (exitAction === 'fully-liquidated') {
            outcomePositions[exitAction].push(data.position);
            alertedPositions.delete(key);
        } else if (exitAction === 'risk-cleared' || exitAction === 'closed-by-trader') {
            if (shouldSendUnconfirmedOutcome(data, now)) {
                outcomePositions[exitAction].push(data.position);
                alertedPositions.delete(key);
            } else {
                alertedPositions.set(key, { ...data, inactiveSince: data.inactiveSince || now });
            }
        } else if (exitAction === 'active') {
            const currentPosition = currentPositionsByKey.get(key) || data.position;
            const updatedData = { ...data, position: currentPosition, inactiveSince: undefined };

            if (shouldSendIncidentProgress(updatedData, now)) {
                const kind = updatedData.hadLiquidation ? 'partial-liquidation' : 'risk-persists';
                progressPositions[kind].push(currentPosition);
                updatedData.lastProgressAlertTime = now;
            }

            alertedPositions.set(key, updatedData);
        } else {
            alertedPositions.set(key, data);
        }
    }

    for (const [outcome, positions] of Object.entries(outcomePositions)) {
        if (positions.length > 0) {
            await sendPositionOutcomeAlert(outcome, positions);
        }
    }

    for (const [kind, positions] of Object.entries(progressPositions)) {
        if (positions.length > 0) {
            await sendIncidentProgressAlert(kind, positions);
        }
    }

    // Start a new incident only when the position has not already been alerted.
    const newAlerts = [];

    for (const pos of significantPositions) {
        const key = getPositionKey(pos);
        const existing = alertedPositions.get(key);

        if (!existing) {
            newAlerts.push(pos);
            alertedPositions.set(key, {
                lastAlertTime: now,
                lastProgressAlertTime: now,
                lastTradeCheckTime: now,
                position: pos,
                seenTradeIds: [],
                hadLiquidation: false,
                hadTraderReduction: false
            });
        } else {
            alertedPositions.set(key, { ...existing, position: pos, inactiveSince: undefined });
        }
    }

    // Send alerts
    if (newAlerts.length > 0) {
        await sendSlackAlert(newAlerts);
    }

    saveAlertState();

    // Log summary
    const skippedLowValue = enrichedPositions.length - significantPositions.length;
    if (skippedLowValue > 0) {
        console.log(`[${getTimestamp()}] ℹ️ Skipped ${skippedLowValue} position(s) with value at risk < $${MIN_VALUE_AT_RISK}`);
    }
    if (newAlerts.length === 0 && significantPositions.length > 0) {
        const ongoingCount = significantPositions.length - newAlerts.length;
        if (ongoingCount > 0) {
            console.log(`[${getTimestamp()}] ℹ️ ${ongoingCount} open incident(s), no initial alert sent`);
        }
    }
}

function startServer() {
    loadAlertState();

    // Schedule checks every 1 minute
    cron.schedule('*/1 * * * *', () => {
        runLiquidationCheck();
    });

    // Initial check
    setTimeout(() => runLiquidationCheck(), 5000);

    app.listen(PORT, () => {
        console.log(`[${getTimestamp()}] 🚀 Liquidation Monitor running on port ${PORT}`);
        console.log(`[${getTimestamp()}] 📊 Monitoring every 1 minute`);
        console.log(`[${getTimestamp()}] ⏱️ Incident progress updates: every 30 minutes`);
        console.log(`[${getTimestamp()}] 💰 Min value at risk for alerts: $${MIN_VALUE_AT_RISK}`);
        console.log(`[${getTimestamp()}] 👥 Mention threshold: > ${formatUsd(MENTION_VALUE_AT_RISK_USD)} or bankrupt`);
        if (DRY_RUN) {
            console.log(`[${getTimestamp()}] 🔕 DRY RUN MODE: Alerts will print to console instead of Slack`);
            console.log(`[${getTimestamp()}] 💡 To enable Slack alerts, run without --dry-run flag`);
        }
    });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    ALERT_COOLDOWN_MS,
    MENTION_VALUE_AT_RISK_USD,
    UNCONFIRMED_EXIT_RETENTION_MS,
    alertedPositions,
    buildIncidentProgressAlertMessage,
    buildLiquidationAlertMessage,
    buildPositionOutcomeAlertMessage,
    formatPositionLine,
    getAlertExitAction,
    getAlertedPositionChecks,
    getTotalValueAtRisk,
    getValueAtRisk,
    getPositionKey,
    getPositionKeySet,
    isHouseAccount,
    isBankruptPosition,
    loadAlertState,
    mergeIncidentTradeEvents,
    processAlerts,
    saveAlertState,
    shouldSendIncidentProgress,
    shouldMentionPositions,
    shouldSendUnconfirmedOutcome,
    startServer
};
