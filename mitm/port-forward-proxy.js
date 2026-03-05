// port-forward-proxy.js - NO PORT CHANGES NEEDED
const net = require('net');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class PortForwardProxy {
  constructor() {
    this.proxyPort = 3000;           // Same as Flutter expects
    this.backendPort = 3000;         // Same as backend runs on
    this.snifferPort = 3002;         // For capturing traffic
    
    this.capturesDir = path.join(__dirname, 'port-captures');
    this.setupDirectories();
    
    console.log(`
🎯 PORT FORWARD PROXY - NO CHANGES NEEDED
📍 Listening on: port ${this.proxyPort} (SAME AS ALWAYS!)
🎯 Forwarding to: port ${this.backendPort} (SAME BACKEND!)
🔍 Sniffing on: port ${this.snifferPort}
📁 Captures: ${this.capturesDir}
    `);
  }
  
  setupDirectories() {
    if (!fs.existsSync(this.capturesDir)) {
      fs.mkdirSync(this.capturesDir, { recursive: true });
    }
    
    // Create log files
    this.logFile = path.join(this.capturesDir, 'all-traffic.jsonl');
    this.decisionFile = path.join(this.capturesDir, 'decisions.jsonl');
    this.webSocketFile = path.join(this.capturesDir, 'websocket.jsonl');
    
    // Clear old logs
    [this.logFile, this.decisionFile, this.webSocketFile].forEach(file => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
  }
  
  start() {
    // 1. First, kill anything using port 3000
    this.killProcessOnPort(3000);
    
    // 2. Start TCP proxy that forwards traffic
    this.startTCPProxy();
    
    // 3. Start WebSocket sniffer
    this.startWebSocketSniffer();
    
    // 4. Start your actual backend
    this.startBackend();
    
    console.log('\n✅✅✅ EVERYTHING READY! ✅✅✅');
    console.log('📱 Flutter: ws://localhost:3000 (NO CHANGES!)');
    console.log('🚀 Backend: http://localhost:3000 (NO CHANGES!)');
    console.log('👁️  Capturing all traffic...');
  }
  
  killProcessOnPort(port) {
    console.log(`🛑 Killing processes on port ${port}...`);
    try {
      if (process.platform === 'win32') {
        execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { stdio: 'pipe' });
        execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`, { stdio: 'pipe' });
      } else {
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' });
      }
      console.log(`✅ Cleared port ${port}`);
      // Wait a moment
      setTimeout(() => {}, 1000);
    } catch (e) {
      console.log(`⚠️ No processes found on port ${port}`);
    }
  }
  
  startTCPProxy() {
    // Create a TCP server that forwards traffic
    const server = net.createServer((clientSocket) => {
      console.log(`🔗 Client connected from ${clientSocket.remoteAddress}`);
      
      // Connect to backend
      const backendSocket = net.createConnection({
        host: '127.0.0.1',
        port: this.backendPort
      });
      
      let clientBuffer = Buffer.alloc(0);
      let backendBuffer = Buffer.alloc(0);
      
      // Client → Backend (capture requests)
      clientSocket.on('data', (data) => {
        clientBuffer = Buffer.concat([clientBuffer, data]);
        this.captureTCPData('client_to_backend', data);
        
        // Check for WebSocket upgrade
        const dataStr = data.toString();
        if (dataStr.includes('Upgrade: websocket')) {
          this.handleWebSocketUpgrade(dataStr);
        }
        
        // Forward to backend
        backendSocket.write(data);
      });
      
      // Backend → Client (capture responses)
      backendSocket.on('data', (data) => {
        backendBuffer = Buffer.concat([backendBuffer, data]);
        this.captureTCPData('backend_to_client', data);
        clientSocket.write(data);
      });
      
      // Handle errors
      clientSocket.on('error', (err) => {
        console.error('❌ Client socket error:', err.message);
      });
      
      backendSocket.on('error', (err) => {
        console.error('❌ Backend socket error:', err.message);
      });
      
      // Clean up on close
      clientSocket.on('close', () => {
        backendSocket.end();
      });
      
      backendSocket.on('close', () => {
        clientSocket.end();
      });
    });
    
    server.listen(this.proxyPort, () => {
      console.log(`✅ TCP Proxy listening on port ${this.proxyPort}`);
    });
    
    this.tcpServer = server;
  }
  
  startWebSocketSniffer() {
    // WebSocket server to capture messages
    const wss = new WebSocket.Server({ port: this.snifferPort });
    
    wss.on('connection', (ws, req) => {
      const url = require('url');
      const parsedUrl = url.parse(req.url, true);
      const phone = parsedQueryParam(parsedUrl.query, 'phone');
      const userId = parsedQueryParam(parsedUrl.query, 'userId');
      
      console.log(`👁️  WebSocket Sniffer Connected: ${phone || userId || 'unknown'}`);
      
      // Also connect to the actual WebSocket to sniff messages
      const backendWs = new WebSocket(`ws://localhost:${this.backendPort}${req.url}`);
      
      // Flutter → Backend messages
      ws.on('message', (data) => {
        this.captureWebSocketMessage('flutter', phone || userId, data);
        backendWs.send(data);
      });
      
      // Backend → Flutter messages  
      backendWs.on('message', (data) => {
        this.captureWebSocketMessage('backend', phone || userId, data);
        ws.send(data);
      });
      
      // Handle disconnections
      ws.on('close', () => {
        backendWs.close();
        console.log(`👁️  WebSocket Sniffer Disconnected`);
      });
      
      backendWs.on('close', () => {
        ws.close();
      });
    });
    
    console.log(`✅ WebSocket Sniffer on port ${this.snifferPort}`);
  }
  
  handleWebSocketUpgrade(dataStr) {
    console.log('\n🔗 WebSocket Upgrade Detected!');
    
    // Extract URL
    const urlMatch = dataStr.match(/GET (\/ws[^\s]+)/);
    if (urlMatch) {
      const url = urlMatch[1];
      const parsed = new URL(url, 'http://localhost');
      
      console.log('   URL:', url);
      console.log('   Phone:', parsed.searchParams.get('phone'));
      console.log('   UserId:', parsed.searchParams.get('userId'));
      console.log('   Role:', parsed.searchParams.get('role'));
    }
    
    this.logEvent('websocket_upgrade', { data: dataStr.substring(0, 200) });
  }
  
  captureTCPData(direction, data) {
    const dataStr = data.toString();
    
    // Look for JSON in the data
    const jsonMatches = dataStr.match(/\{.*\}/g);
    if (jsonMatches) {
      jsonMatches.forEach(jsonStr => {
        try {
          const jsonData = JSON.parse(jsonStr);
          this.captureJSONMessage(direction, jsonData);
        } catch (e) {
          // Not valid JSON
        }
      });
    }
  }
  
  captureWebSocketMessage(direction, user, data) {
    try {
      const message = JSON.parse(data.toString());
      const timestamp = new Date().toISOString();
      
      const entry = {
        timestamp,
        direction,
        user,
        type: message.type || 'unknown',
        data: message.data || message
      };
      
      // Save to WebSocket log
      fs.appendFileSync(this.webSocketFile, JSON.stringify(entry) + '\n');
      
      // Console output
      const icon = direction === 'flutter' ? '📤' : '📥';
      console.log(`${icon} [${new Date().toLocaleTimeString()}] ${user}: ${message.type || 'NO_TYPE'}`);
      
      // Special handling for decisions
      if (this.isDecisionMessage(message)) {
        this.handleDecisionCapture(entry, message);
      }
      
    } catch (e) {
      // Not JSON, might be binary
    }
  }
  
  captureJSONMessage(direction, jsonData) {
    const timestamp = new Date().toISOString();
    
    const entry = {
      timestamp,
      direction,
      type: jsonData.type || 'http_json',
      data: jsonData
    };
    
    fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    
    // Log HTTP JSON messages
    if (jsonData.type === 'ACCEPT_MATCH' || jsonData.type === 'DECLINE_MATCH') {
      console.log(`🚨 ${direction.toUpperCase()}: ${jsonData.type}`);
    }
  }
  
  isDecisionMessage(message) {
    return message.type === 'ACCEPT_MATCH' || 
           message.type === 'DECLINE_MATCH' ||
           message.type === 'MATCH_DECISION' ||
           (message.data && message.data.decision) ||
           (message.type && message.type.includes('DECISION'));
  }
  
  handleDecisionCapture(entry, message) {
    console.log('\n🚨🚨🚨 DECISION CAPTURED! 🚨🚨🚨');
    console.log('   Direction:', entry.direction);
    console.log('   Type:', message.type);
    console.log('   Match:', message.data?.matchId);
    console.log('   User:', entry.user);
    console.log('   Data:', JSON.stringify(message.data || message, null, 2));
    
    // Save to decision log
    const decisionEntry = {
      ...entry,
      capturedAt: 'port-forward-proxy',
      matchId: message.data?.matchId,
      decision: message.data?.decision || message.type
    };
    
    fs.appendFileSync(this.decisionFile, JSON.stringify(decisionEntry) + '\n');
    
    // Also create human-readable log
    const humanFile = path.join(this.capturesDir, 'decisions-human.log');
    fs.appendFileSync(humanFile, `
=== DECISION ===
Time: ${new Date().toLocaleString()}
From: ${entry.direction === 'flutter' ? 'Flutter App' : 'Backend'}
User: ${entry.user}
Type: ${message.type}
Match ID: ${message.data?.matchId || 'N/A'}
Decision: ${message.data?.decision || 'N/A'}
Full Data:
${JSON.stringify(message.data || message, null, 2)}
===============
\n`);
  }
  
  logEvent(event, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...data
    };
    
    fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
  }
  
  startBackend() {
    console.log('\n🚀 Starting your backend...');
    
    // We need to start backend on same port but different address
    // Use a slight delay
    setTimeout(() => {
      try {
        // Check if app.js exists
        const appPath = path.join(__dirname, 'app.js');
        if (fs.existsSync(appPath)) {
          console.log('📦 Loading your backend from:', appPath);
          
          // Clear require cache to get fresh backend
          delete require.cache[require.resolve(appPath)];
          
          // Modify process env to use same port
          process.env.PORT = this.backendPort;
          
          // Import your backend
          require(appPath);
          
          console.log(`✅ Backend started on port ${this.backendPort}`);
        } else {
          console.error('❌ app.js not found in:', __dirname);
          console.log('💡 Make sure port-forward-proxy.js is in your backend directory');
        }
      } catch (error) {
        console.error('❌ Failed to start backend:', error.message);
        console.log('\n💡 Alternative: Start backend manually in another terminal:');
        console.log('   node app.js');
      }
    }, 2000);
  }
}

// Helper function
function parsedQueryParam(query, key) {
  if (!query || !query[key]) return null;
  return decodeURIComponent(query[key].toString());
}

// Run the proxy
if (require.main === module) {
  const proxy = new PortForwardProxy();
  proxy.start();
  
  // Print stats periodically
  setInterval(() => {
    try {
      const wsCount = fs.existsSync(proxy.webSocketFile) 
        ? fs.readFileSync(proxy.webSocketFile, 'utf8').split('\n').filter(l => l.trim()).length
        : 0;
      
      const decisionCount = fs.existsSync(proxy.decisionFile)
        ? fs.readFileSync(proxy.decisionFile, 'utf8').split('\n').filter(l => l.trim()).length
        : 0;
      
      console.log(`\n📊 Stats: ${wsCount} WS messages, ${decisionCount} decisions captured`);
    } catch (e) {
      // Ignore errors
    }
  }, 10000);
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    console.log(`📁 Check captures in: ${proxy.capturesDir}`);
    process.exit(0);
  });
}

module.exports = PortForwardProxy;
