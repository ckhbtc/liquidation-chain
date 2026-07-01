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
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between alerts for same position
const HOUSE_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours for non-bankrupt house account follow-ups
const UNCONFIRMED_EXIT_RETENTION_MS = 30 * 60 * 1000; // Keep checking briefly for delayed liquidation trades
const HOUSE_SUBACCOUNT_IDS = new Set([
    '0x90de5ac1987a9874ae868e703c4c6320548a316a000000000000000000000000',
    '0x93073bf6ed84f9093f96f525da6cb859776b75d6000000000000000000000000'
]);
const DATA_DIR = path.join(__dirname, 'data');
const ALERT_STATE_FILE = path.join(DATA_DIR, 'alert-state.json');

// Initialize Slack client (only if not in dry run mode)
const slack = DRY_RUN ? null : new WebClient(SLACK_BOT_TOKEN);

// Track alerted positions: Map<positionKey, {lastAlertTime, position, inactiveSince?}>
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
        market_id: data.position?.market_id,
        subaccount_id: data.position?.subaccount_id
    })).filter(check => check.market_id && check.subaccount_id);
}

function retainUnconfirmedExit(key, data, now) {
    const inactiveSince = data.inactiveSince || now;

    if (now - inactiveSince >= UNCONFIRMED_EXIT_RETENTION_MS) {
        alertedPositions.delete(key);
        return;
    }

    alertedPositions.set(key, { ...data, inactiveSince });
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

function getAlertExitAction(key, { currentLiquidatableKeys, currentOpenPositionKeys, confirmedLiquidatedKeys }) {
    if (currentLiquidatableKeys.has(key)) {
        return 'active';
    }

    if (currentOpenPositionKeys.has(key)) {
        return 'retain';
    }

    if (confirmedLiquidatedKeys.has(key)) {
        return 'resolved';
    }

    return 'clear';
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

function getAlertCooldownMs(position) {
    if (isHouseAccount(position) && !isBankruptPosition(position)) {
        return HOUSE_ALERT_COOLDOWN_MS;
    }

    return ALERT_COOLDOWN_MS;
}

function shouldSendFollowUp(position, existingAlert, now) {
    const becameBankrupt = isBankruptPosition(position) && !isBankruptPosition(existingAlert.position);
    if (becameBankrupt) {
        return true;
    }

    return now - existingAlert.lastAlertTime >= getAlertCooldownMs(position);
}

function formatPositionLine(position) {
    const bankruptPrefix = isBankruptPosition(position) ? 'BANKRUPT ' : '';
    const housePrefix = isHouseAccount(position) ? '🏠 ' : '';
    return `${bankruptPrefix}${housePrefix}${getBaseAssetDisplay(position)} ${position.position_type} ${formatAmount(position.quantity)}, ` +
        `risk ${formatUsd(getValueAtRisk(position))}, entry ${formatPrice(position.entry_price)}, ` +
        `mark ${formatPrice(position.mark_price)}, liq ${formatPrice(position.liquidation_price)}, ` +
        `bkr ${formatPrice(position.bankruptcy_price)}`;
}

function buildLiquidationAlertMessage(liquidablePositions, isFollowUp = false) {
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
    confirmedLiquidatedPositionKeys: [],
    status: 'starting',
    error: null
};

async function sendSlackAlert(liquidablePositions, isFollowUp = false) {
    if (liquidablePositions.length === 0) return;

    // In dry run mode, print to console instead of sending to Slack
    if (DRY_RUN) {
        printAlertToConsole(liquidablePositions, isFollowUp);
        return;
    }

    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) return;

    const message = buildLiquidationAlertMessage(liquidablePositions, isFollowUp);

    try {
        const result = await slack.chat.postMessage(message);
        console.log(`[${getTimestamp()}] ✅ Slack alert sent for ${liquidablePositions.length} positions to ${result.channel}${isFollowUp ? ' (follow-up)' : ''}`);
    } catch (error) {
        console.error(`[${getTimestamp()}] ❌ Slack alert failed:`, error.message);
    }
}

async function sendResolvedAlert(resolvedPositions) {
    if (resolvedPositions.length === 0) return;

    const resolvedText = getResolvedAlertText(resolvedPositions);

    // In dry run mode, print to console instead of sending to Slack
    if (DRY_RUN) {
        console.log('\n' + '='.repeat(60));
        console.log(`[${getTimestamp()}] POSITIONS RESOLVED (DRY RUN MODE)`);
        console.log('='.repeat(60));
        console.log(resolvedText);
        console.log('='.repeat(60) + '\n');
        return;
    }

    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) return;

    const message = buildResolvedAlertMessage(resolvedPositions);

    try {
        const result = await slack.chat.postMessage(message);
        console.log(`[${getTimestamp()}] ✅ Resolved alert sent for ${resolvedPositions.length} positions to ${result.channel}`);
    } catch (error) {
        console.error(`[${getTimestamp()}] ❌ Resolved alert failed:`, error.message);
    }
}

function getResolvedAlertText(resolvedPositions) {
    const shownResolvedPositions = resolvedPositions.slice(0, MAX_ALERT_POSITIONS);
    const resolvedLines = shownResolvedPositions.map(pos => `${getBaseAssetDisplay(pos)} ${pos.position_type}`);
    const hiddenResolvedCount = resolvedPositions.length - shownResolvedPositions.length;

    if (hiddenResolvedCount > 0) {
        resolvedLines.push(`+${hiddenResolvedCount} more`);
    }

    return `${resolvedPositions.length} position${resolvedPositions.length === 1 ? '' : 's'} resolved: ${resolvedLines.join(', ')}`;
}

function buildResolvedAlertMessage(resolvedPositions) {
    const resolvedText = getResolvedAlertText(resolvedPositions);

    return {
        channel: SLACK_CHANNEL_ID,
        text: resolvedText,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: resolvedText
                }
            }
        ]
    };
}

function printAlertToConsole(liquidablePositions, isFollowUp = false) {
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
                    confirmedLiquidatedPositionKeys: results.confirmed_liquidated_position_keys || [],
                    totalPositions: results.total_positions,
                    status: 'healthy',
                    error: null
                };

                console.log(`[${getTimestamp()}] ✅ Check complete: ${results.liquidable_count || 0} liquidable positions`);

                // Process alerts with throttling and resolved detection
                processAlerts(
                    results.liquidable_positions || [],
                    results.open_positions || [],
                    results.confirmed_liquidated_position_keys || []
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

// Process alerts with throttling and resolved detection
async function processAlerts(currentLiquidablePositions, currentOpenPositions = [], confirmedLiquidatedPositionKeys = []) {
    const now = Date.now();
    const confirmedLiquidatedKeys = new Set(confirmedLiquidatedPositionKeys);

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

    // Check for confirmed liquidations. Do not call "resolved" when a position is
    // merely still open but no longer liquidatable.
    const resolvedPositions = [];
    for (const [key, data] of alertedPositions.entries()) {
        const exitAction = getAlertExitAction(key, {
            currentLiquidatableKeys: currentPositionKeys,
            currentOpenPositionKeys,
            confirmedLiquidatedKeys
        });

        if (exitAction === 'resolved') {
            resolvedPositions.push(data.position);
            alertedPositions.delete(key);
        } else if (exitAction === 'clear') {
            retainUnconfirmedExit(key, data, now);
        } else if (data.inactiveSince) {
            alertedPositions.set(key, { ...data, inactiveSince: undefined });
        }
    }

    // Send resolved alerts
    if (resolvedPositions.length > 0) {
        await sendResolvedAlert(resolvedPositions);
    }

    // Separate new alerts from follow-up alerts
    const newAlerts = [];
    const followUpAlerts = [];

    for (const pos of significantPositions) {
        const key = getPositionKey(pos);
        const existing = alertedPositions.get(key);

        if (!existing) {
            // New position - send alert immediately
            newAlerts.push(pos);
            alertedPositions.set(key, { lastAlertTime: now, position: pos });
        } else if (shouldSendFollowUp(pos, existing, now)) {
            // Existing position past cooldown - send follow-up alert
            followUpAlerts.push(pos);
            alertedPositions.set(key, { lastAlertTime: now, position: pos });
        } else {
            // Existing position within cooldown - update position data but don't alert
            alertedPositions.set(key, { lastAlertTime: existing.lastAlertTime, position: pos });
        }
    }

    // Send alerts
    if (newAlerts.length > 0) {
        await sendSlackAlert(newAlerts, false);
    }
    if (followUpAlerts.length > 0) {
        await sendSlackAlert(followUpAlerts, true);
    }

    saveAlertState();

    // Log summary
    const skippedLowValue = enrichedPositions.length - significantPositions.length;
    if (skippedLowValue > 0) {
        console.log(`[${getTimestamp()}] ℹ️ Skipped ${skippedLowValue} position(s) with value at risk < $${MIN_VALUE_AT_RISK}`);
    }
    if (newAlerts.length === 0 && followUpAlerts.length === 0 && significantPositions.length > 0) {
        const throttledCount = significantPositions.length - newAlerts.length - followUpAlerts.length;
        if (throttledCount > 0) {
            console.log(`[${getTimestamp()}] ℹ️ ${throttledCount} position(s) within cooldown, no alert sent`);
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
        console.log(`[${getTimestamp()}] ⏱️ Alert cooldown: 30 minutes per position`);
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
    HOUSE_ALERT_COOLDOWN_MS,
    MENTION_VALUE_AT_RISK_USD,
    UNCONFIRMED_EXIT_RETENTION_MS,
    buildLiquidationAlertMessage,
    buildResolvedAlertMessage,
    formatPositionLine,
    getAlertExitAction,
    getAlertCooldownMs,
    getAlertedPositionChecks,
    getTotalValueAtRisk,
    getValueAtRisk,
    getPositionKey,
    getPositionKeySet,
    isHouseAccount,
    isBankruptPosition,
    loadAlertState,
    saveAlertState,
    shouldMentionPositions,
    shouldSendFollowUp,
    startServer
};
