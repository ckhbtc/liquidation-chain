#!/bin/bash
echo "�� Liquidation Monitor - AWS Lightsail Deployment"

# Install system dependencies
sudo apt update && sudo apt upgrade -y
sudo apt install python3 python3-pip nodejs npm -y

# Install PM2
sudo npm install -g pm2

# Install dependencies
npm install

# Create Python virtual environment and install pyinjective
python3 -m venv liquidation-env
source liquidation-env/bin/activate
pip install pyinjective
deactivate

# Configuration embedded in liquidation-chain.js
echo "✅ Configuration embedded in application"

# Configure firewall
sudo ufw allow 16000
sudo ufw enable

# Start with PM2
pm2 start liquidation-chain.js --name liquidation-monitor
pm2 save
pm2 startup

echo "✅ Deployment complete! Server running on port 16000"
echo "📝 To restart: pm2 restart liquidation-monitor"
