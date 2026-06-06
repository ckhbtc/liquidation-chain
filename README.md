# Injective Liquidation Monitor

🚨 Real-time monitoring system for liquidable positions on Injective Protocol with Slack alerts.

## Features

- 📊 **Every 1 minute**: Automated position monitoring
- 💬 **Slack Alerts**: Compact notifications for liquidable positions
- 🌐 **Express Dashboard**: Web interface with monitoring endpoints
- ☁️ **AWS Lightsail Ready**: Optimized for cloud deployment
- 🐍 **Python + Node.js**: Leverages Injective SDK with Express server

## Quick Setup

### Local Development

```bash
# Install dependencies
npm install
pip3 install injective-py

# Configure environment
cp .env.example .env
# then edit .env with your Slack bot token, channel ID, and user IDs

# Start server
npm start

# Or run without sending to Slack
npm run dry-run
```

Server runs on http://localhost:16000

### AWS Lightsail Deployment

```bash
# Make deploy script executable
chmod +x deploy.sh

# Run deployment
./deploy.sh

# Configure environment
cp .env.example .env
nano .env

# Restart service
pm2 restart liquidation-monitor
```

## API Endpoints

- `GET /` - Service status
- `GET /status` - Detailed monitoring data
- `POST /check-now` - Trigger immediate check
- `GET /health` - Health check

## Slack Setup

1. Create a Slack app with a bot token: https://api.slack.com/apps
2. Add the `chat:write` scope and install the app to your workspace
3. Invite the bot to the channel you want alerts in
4. Add the bot token, channel ID, and user IDs to mention to `.env`:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_CHANNEL_ID=C0XXXXXXXXX
   SLACK_USER_IDS=U0XXXXXXXXX,U0YYYYYYYYY
   ```
5. Restart: `pm2 restart liquidation-monitor`

## Monitoring

- **Check Interval**: Every 1 minute
- **Alert Trigger**: Liquidable position with value at risk ≥ $1
- **Mention Trigger**: Only configured users when alert value at risk is > $25,000 or any position is bankrupt
- **Alert Cooldown**: 30 minutes per position
- **Port**: 16000
- **Process Manager**: PM2

View logs: `pm2 logs liquidation-monitor`

## Alert Format

Slack alerts include:
- Total liquidable positions and value at risk
- One compact line per position: market, direction, quantity, risk, entry, and mark
- No subaccount IDs

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Express.js    │───▶│   Python Script  │───▶│ Injective Chain │
│   (Scheduler)   │    │  (SDK Handler)   │    │   (Positions)   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │
         ▼
┌─────────────────┐
│   Slack Bot     │
│    (Alerts)     │
└─────────────────┘
```

Built for reliable 24/7 monitoring with AWS Lightsail deployment.
