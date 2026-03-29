require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { exec } = require('child_process');
const path = require('path');
const { WebClient } = require('@slack/web-api');

const app = express();
const PORT = 16000;

// Dry run mode - can be enabled via command line or environment variable
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

// Slack configuration
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = 'C08D6LP5C5R';
const SLACK_USER_IDS = ['U03B55LJPNY', 'U06999CUUTW'];

// Alert configuration
const MIN_VALUE_AT_RISK = 1; // Minimum $1 value at risk to send alert
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between alerts for same position

// Initialize Slack client (only if not in dry run mode)
const slack = DRY_RUN ? null : new WebClient(SLACK_BOT_TOKEN);

// Track alerted positions: Map<positionKey, {lastAlertTime, position}>
const alertedPositions = new Map();

// Helper function to get formatted timestamp
function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Helper function to create a unique key for a position
function getPositionKey(position) {
    return `${position.subaccount_id}:${position.market_id}`;
}

// Helper function to calculate value at risk for a position
function getValueAtRisk(position) {
    return position.quantity * position.mark_price;
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

    const totalLiquidable = liquidablePositions.length;
    const totalValueAtRisk = liquidablePositions.reduce((sum, pos) =>
        sum + (pos.quantity * pos.mark_price), 0
    ).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Create mentions for specified users
    const userMentions = SLACK_USER_IDS.map(userId => `<@${userId}>`).join(' ');

    const headerText = isFollowUp ? "⚠️ Still Liquidatable (30min Follow-up)" : "🚨 Liquidatable Position Alert";

    // Create position details
    const positionDetails = liquidablePositions.map((pos, index) => {
        const marketDisplay = pos.market_ticker || pos.market_id;
        return `*${index + 1}. ${pos.position_type} Position*\n` +
            `Market: \`${marketDisplay}\`\n` +
            `Quantity: ${parseFloat(pos.quantity.toFixed(4))}\n` +
            `Entry Price: $${pos.entry_price.toFixed(2)}\n` +
            `Mark Price: $${pos.mark_price.toFixed(2)}\n` +
            `Liquidation Price: $${pos.liquidation_price.toFixed(2)}\n` +
            `Value at Risk: $${getValueAtRisk(pos).toFixed(2)}\n` +
            `Subaccount: \`${pos.subaccount_id}\``;
    }).join('\n\n');

    // Build blocks array - only include user mentions section on follow-up alerts
    const blocks = [
        {
            type: "header",
            text: {
                type: "plain_text",
                text: headerText
            }
        },
        {
            type: "section",
            fields: [
                {
                    type: "mrkdwn",
                    text: `*Total Liquidatable:* ${totalLiquidable}`
                },
                {
                    type: "mrkdwn",
                    text: `*Value at Risk:* $${totalValueAtRisk}`
                }
            ]
        },
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: positionDetails
            }
        }
    ];

    // Only add user mentions on follow-up alerts
    if (isFollowUp) {
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `👥 ${userMentions}`
            }
        });
    }

    const message = {
        channel: SLACK_CHANNEL_ID,
        text: `${isFollowUp ? '⚠️' : '🚨'} *${headerText}*${isFollowUp ? ' ' + userMentions : ''}`,
        blocks: blocks
    };

    try {
        const result = await slack.chat.postMessage(message);
        console.log(`[${getTimestamp()}] ✅ Slack alert sent for ${totalLiquidable} positions to ${result.channel}${isFollowUp ? ' (follow-up)' : ''}`);
    } catch (error) {
        console.error(`[${getTimestamp()}] ❌ Slack alert failed:`, error.message);
    }
}

async function sendResolvedAlert(resolvedPositions) {
    if (resolvedPositions.length === 0) return;

    // In dry run mode, print to console instead of sending to Slack
    if (DRY_RUN) {
        console.log('\n' + '='.repeat(60));
        console.log(`[${getTimestamp()}] ✅ RESOLVED POSITION ALERT (DRY RUN MODE)`);
        console.log('='.repeat(60));
        resolvedPositions.forEach((pos, index) => {
            const marketDisplay = pos.market_ticker || pos.market_id;
            console.log(`${index + 1}. ${pos.position_type} Position - ${marketDisplay} - RESOLVED`);
        });
        console.log('='.repeat(60) + '\n');
        return;
    }

    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) return;

    const positionDetails = resolvedPositions.map((pos, index) => {
        const marketDisplay = pos.market_ticker || pos.market_id;
        return `*${index + 1}. ${pos.position_type} Position*\n` +
            `Market: \`${marketDisplay}\`\n` +
            `Subaccount: \`${pos.subaccount_id}\``;
    }).join('\n\n');

    const message = {
        channel: SLACK_CHANNEL_ID,
        text: `✅ *Positions Resolved* - ${resolvedPositions.length} position(s) liquidated or closed`,
        blocks: [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "✅ Positions Resolved"
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `${resolvedPositions.length} previously liquidatable position(s) have been resolved (liquidated or closed).`
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: positionDetails
                }
            }
        ]
    };

    try {
        const result = await slack.chat.postMessage(message);
        console.log(`[${getTimestamp()}] ✅ Resolved alert sent for ${resolvedPositions.length} positions to ${result.channel}`);
    } catch (error) {
        console.error(`[${getTimestamp()}] ❌ Resolved alert failed:`, error.message);
    }
}

function printAlertToConsole(liquidablePositions, isFollowUp = false) {
    const totalLiquidable = liquidablePositions.length;
    const totalValueAtRisk = liquidablePositions.reduce((sum, pos) =>
        sum + (pos.quantity * pos.mark_price), 0
    ).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const headerText = isFollowUp ? "⚠️ STILL LIQUIDATABLE (30min Follow-up)" : "🚨 LIQUIDATABLE POSITION ALERT";

    console.log('\n' + '='.repeat(60));
    console.log(`[${getTimestamp()}] ${headerText} (DRY RUN MODE)`);
    console.log('='.repeat(60));
    console.log(`📊 Total Liquidatable: ${totalLiquidable}`);
    console.log(`💰 Value at Risk: $${totalValueAtRisk}`);
    console.log('');

    liquidablePositions.forEach((pos, index) => {
        const marketDisplay = pos.market_ticker || pos.market_id;
        console.log(`${index + 1}. ${pos.position_type} Position`);
        console.log(`   Market: ${marketDisplay}`);
        console.log(`   Quantity: ${parseFloat(pos.quantity.toFixed(4))}`);
        console.log(`   Entry Price: $${pos.entry_price.toFixed(2)}`);
        console.log(`   Mark Price: $${pos.mark_price.toFixed(2)}`);
        console.log(`   Liquidation Price: $${pos.liquidation_price.toFixed(2)}`);
        console.log(`   Value at Risk: $${getValueAtRisk(pos).toFixed(2)}`);
        console.log(`   Subaccount: ${pos.subaccount_id}`);
        console.log('');
    });

    console.log(`👥 Would mention: ${SLACK_USER_IDS.join(', ')}`);
    console.log(`📢 Would post to channel: ${SLACK_CHANNEL_ID}`);
    console.log('='.repeat(60) + '\n');
}

function runLiquidationCheck() {
    return new Promise((resolve) => {
        console.log(`[${getTimestamp()}] 🔍 Running liquidation check...`);

        const pythonScript = path.join(__dirname, 'liquidation_monitor.py');
        const venvPython = path.join(__dirname, 'liquidation-env', 'bin', 'python');

        // In dry run mode, always use system python3, otherwise prefer virtual environment
        const pythonCmd = DRY_RUN ? 'python3' : (require('fs').existsSync(venvPython) ? `"${venvPython}"` : 'python3');
        exec(`${pythonCmd} "${pythonScript}"`, { timeout: 60000 }, (error, stdout, stderr) => {
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
                    totalPositions: results.total_positions,
                    status: 'healthy',
                    error: null
                };

                console.log(`[${getTimestamp()}] ✅ Check complete: ${results.liquidable_count || 0} liquidable positions`);

                // Process alerts with throttling and resolved detection
                processAlerts(results.liquidable_positions || []);
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
async function processAlerts(currentLiquidablePositions) {
    const now = Date.now();
    const currentPositionKeys = new Set();

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

    // Track current position keys
    for (const pos of significantPositions) {
        currentPositionKeys.add(getPositionKey(pos));
    }

    // Check for resolved positions (were alerted but no longer liquidable)
    const resolvedPositions = [];
    for (const [key, data] of alertedPositions.entries()) {
        if (!currentPositionKeys.has(key)) {
            resolvedPositions.push(data.position);
            alertedPositions.delete(key);
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
        } else if (now - existing.lastAlertTime >= ALERT_COOLDOWN_MS) {
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

    // Log summary
    const skippedLowValue = enrichedPositions.length - significantPositions.length;
    if (skippedLowValue > 0) {
        console.log(`[${getTimestamp()}] ℹ️ Skipped ${skippedLowValue} position(s) with value at risk < $${MIN_VALUE_AT_RISK}`);
    }
    if (newAlerts.length === 0 && followUpAlerts.length === 0 && significantPositions.length > 0) {
        const throttledCount = significantPositions.length - newAlerts.length - followUpAlerts.length;
        if (throttledCount > 0) {
            console.log(`[${getTimestamp()}] ℹ️ ${throttledCount} position(s) within 30min cooldown, no alert sent`);
        }
    }
}

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
    if (DRY_RUN) {
        console.log(`[${getTimestamp()}] 🔕 DRY RUN MODE: Alerts will print to console instead of Slack`);
        console.log(`[${getTimestamp()}] 💡 To enable Slack alerts, run without --dry-run flag`);
    }
});
