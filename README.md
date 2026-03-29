# Injective Liquidation Monitor

🚨 Real-time monitoring system for liquidable positions on Injective Protocol with Slack alerts.

## Features

- 📊 **Every 5 minutes**: Automated position monitoring
- 💬 **Slack Alerts**: Instant notifications for liquidable positions  
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
echo "SLACK_WEBHOOK_URL=your_webhook_here" >> .env

# Start server
npm start
```

Server runs on http://localhost:14000

### AWS Lightsail Deployment

```bash
# Make deploy script executable
chmod +x deploy.sh

# Run deployment
./deploy.sh

# Edit environment with your Slack webhook
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

1. Create Slack webhook: https://api.slack.com/apps
2. Add webhook URL to `.env`:
   ```
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK
   ```
3. Restart: `pm2 restart liquidation-monitor`

## Monitoring

- **Check Interval**: Every 5 minutes
- **Alert Trigger**: Any liquidable position found  
- **Port**: 14000 (configurable)
- **Process Manager**: PM2

View logs: `pm2 logs liquidation-monitor`

## Alert Format

Slack alerts include:
- 📊 Total liquidable positions
- 💰 Total value at risk
- 📈 Long vs Short breakdown
- 🎯 Top positions by value

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Express.js    │───▶│   Python Script  │───▶│ Injective Chain │
│   (Scheduler)   │    │  (SDK Handler)   │    │   (Positions)   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Slack Webhook  │
│   (Alerts)      │
└─────────────────┘
```

Built for reliable 24/7 monitoring with AWS Lightsail deployment.
