// mitm-proxy.js - COMPLETELY SEPARATE from your backend
const http = require('http');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');
const url = require('url');
const fs = require('fs');
const path = require('path');
const net = require('net');

class MITMProxy {
  constructor() {
    this.proxyPort = 3000;    // What Flutter connects to
    this.backendPort = 3001;  // Where backend actually runs
    
    // Setup directories
    this.capturesDir = path.join(__dirname, 'mitm-captures');
    this.setupDirectories();
    
    // Files
    this.mainLog = path.join(this.capturesDir, 'traffic.jsonl');
    this.wsLog = path.join(this.capturesDir, 'websocket.jsonl');
    this.decisionLog = path.join(this.capturesDir, 'decisions.jsonl');
    
    console.log(`
🎯 MITM PROXY - COMPLETELY SEPARATE
📍 Proxy Port: ${this.proxyPort} (Flutter connects here)
🎯 Backend Port: ${this.backendPort} (Your app.js runs here)
📁 Captures: ${this.capturesDir}
🔌 NO FLUTTER CHANGES NEEDED!
🔌 NO BACKEND CHANGES NEEDED!
    `);
  }
  
  setupDirectories() {
    if (!fs.existsSync(this.capturesDir)) {
      fs.mkdirSync(this.capturesDir, { recursive: true });
    }
    
    // Clear old logs
    [this.mainLog, this.wsLog, this.decisionLog].forEach(file => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
  }
  
  start() {
    return new Promise((resolve) => {
      // Check if port 3000 is available
      this.checkPortAvailable(this.proxyPort).then(() => {
        this.startProxyServer();
        this.startBackendOnPort3001();
        resolve();
      }).catch(() => {
        console.log('⚠️ Port 3000 is in use. Stopping existing services...');
        this.killProcessOnPort(3000);
        this.killProcessOnPort(3001);
        setTimeout(() => {
          this.startProxyServer();
          this.startBackendOnPort3001();
          resolve();
        }, 2000);
      });
    });
  }
  
  startProxyServer() {
    const proxy = httpProxy.createProxyServer({
      target: `http://localhost:${this.backendPort}`,
      ws: true,
      changeOrigin: true
    });
    
    // Create HTTP server
    const server = http.createServer((req, res) => {
      this.logHTTP(req);
      proxy.web(req, res);
    });
    
    // Handle WebSocket upgrades
    server.on('upgrade', (req, socket, head) => {
      this.logWebSocketUpgrade(req);
      proxy.ws(req, socket, head);
    });
    
    // WebSocket message interception
    this.setupWebSocketInterception(proxy);
    
    server.listen(this.proxyPort, () => {
      console.log(`✅ MITM Proxy listening on port ${this.proxyPort}`);
      console.log(`📱 Flutter URL: ws://localhost:${this.proxyPort} (SAME AS BEFORE!)`);
    });
    
    this.server = server;
    this.proxy = proxy;
  }
  
  setupWebSocketInterception(proxy) {
    // Create WebSocket server to spy on traffic
    const wss = new WebSocket.Server({ noServer: true });
    
    // Intercept when proxy establishes WebSocket connection
    proxy.on('open', (wsSocket) => {
      console.log('🔗 WebSocket tunnel established');
    });
    
    // Use separate WebSocket clients to spy on both directions
    this.setupWebSocketSpy();
    
    // Also patch the proxy's WebSocket message handling
    const originalOn = proxy.on;
    proxy.on = function(event, handler) {
      if (event === 'proxyReqWs') {
        // Intercept WebSocket requests
        originalOn.call(this, event, (req, socket, head) => {
          console.log('🎯 Intercepting WebSocket request');
          handler(req, socket, head);
        });
      } else {
        originalOn.call(this, event, handler);
      }
    };
  }
  
  setupWebSocketSpy() {
    // Create two spy connections: one to listen to backend, one to listen to Flutter
    
    // Spy on Backend → Flutter messages
    const backendSpy = new WebSocket(`ws://localhost:${this.backendPort}`);
    
    backendSpy.on('open', () => {
      console.log('👁️ Backend Spy Connected');
    });
    
    backendSpy.on('message', (data) => {
      this.captureMessage('backend', data);
    });
    
    // Spy on Flutter → Backend is trickier...
    // We'll use a TCP proxy for that
    this.setupTCPWebSocketSniffer();
  }
  
  setupTCPWebSocketSniffer() {
    // Create raw TCP server to sniff WebSocket frames
    const tcpServer = net.createServer((socket) => {
      let buffer = '';
      
      socket.on('data', (data) => {
        buffer += data.toString();
        
        // Try to parse as WebSocket frame
        if (buffer.includes('GET /ws')) {
          // This is a WebSocket upgrade request
          console.log('🔍 WebSocket upgrade request captured');
          const urlMatch = buffer.match(/GET (\/ws[^\s]+)/);
          if (urlMatch) {
            const parsed = url.parse(urlMatch[1], true);
            console.log(`📱 Phone: ${parsed.query.phone}, User: ${parsed.query.userId}`);
          }
        }
        
        // Look for JSON messages
        const messages = buffer.split('\n');
        messages.forEach(msg => {
          if (msg.trim().startsWith('{')) {
            try {
              const data = JSON.parse(msg.trim());
              this.captureMessage('flutter', data);
            } catch (e) {
              // Not JSON
            }
          }
        });
      });
    });
    
    tcpServer.listen(3002, () => {
      console.log('🔍 TCP Sniffer on port 3002');
    });
  }
  
  captureMessage(direction, data) {
    try {
      const message = typeof data === 'string' ? JSON.parse(data) : data;
      const timestamp = new Date();
      
      const entry = {
        timestamp: timestamp.toISOString(),
        direction, // 'flutter' or 'backend'
        type: message.type || 'unknown',
        data: message.data || message,
        raw: JSON.stringify(message).substring(0, 1000)
      };
      
      // Save to WebSocket log
      fs.appendFileSync(this.wsLog, JSON.stringify(entry) + '\n');
      
      // Console output
      const icon = direction === 'flutter' ? '📤' : '📥';
      console.log(`${icon} [${timestamp.toLocaleTimeString()}] ${message.type || 'NO_TYPE'}`);
      
      // Special handling for decisions
      if (this.isDecisionMessage(message)) {
        this.handleDecision(entry, message);
      }
      
      // Special handling for match proposals
      if (message.type === 'MATCH_PROPOSAL') {
        console.log('🎯 MATCH PROPOSAL SENT!');
      }
      
    } catch (error) {
      // Not JSON
    }
  }
  
  isDecisionMessage(message) {
    return message.type === 'ACCEPT_MATCH' || 
           message.type === 'DECLINE_MATCH' ||
           message.type === 'MATCH_DECISION' ||
           (message.data && message.data.decision) ||
           (message.type && message.type.includes('DECISION'));
  }
  
  handleDecision(entry, message) {
    console.log('\n🚨🚨🚨 DECISION CAPTURED 🚨🚨🚨');
    console.log('   Direction:', entry.direction);
    console.log('   Type:', message.type);
    console.log('   Match ID:', message.data?.matchId);
    console.log('   Decision:', message.data?.decision);
    
    // Save to decision log
    const decisionEntry = {
      ...entry,
      capturedAt: 'mitm-proxy',
      matchId: message.data?.matchId,
      decisionType: message.data?.decision || message.type
    };
    
    fs.appendFileSync(this.decisionLog, JSON.stringify(decisionEntry) + '\n');
    
    // Also save a human-readable version
    const humanLog = path.join(this.capturesDir, 'decisions-human.log');
    fs.appendFileSync(humanLog, `
=== DECISION ===
Time: ${new Date().toLocaleString()}
From: ${entry.direction === 'flutter' ? 'Flutter App' : 'Backend'}
Type: ${message.type}
Match: ${message.data?.matchId || 'N/A'}
Decision: ${message.data?.decision || message.type}
User: ${message.data?.driverPhone || message.data?.passengerPhone || 'Unknown'}
Data: ${JSON.stringify(message.data || message, null, 2)}
===============
\n`);
  }
  
  logHTTP(req) {
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'HTTP',
      method: req.method,
      url: req.url,
      headers: req.headers
    };
    
    fs.appendFileSync(this.mainLog, JSON.stringify(entry) + '\n');
    console.log(`🌐 ${req.method} ${req.url}`);
  }
  
  logWebSocketUpgrade(req) {
    const parsed = url.parse(req.url, true);
    console.log('\n🔗 WebSocket Connection Attempt:');
    console.log('   URL:', req.url);
    console.log('   Phone:', parsed.query.phone);
    console.log('   UserId:', parsed.query.userId);
    
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'WS_UPGRADE',
      url: req.url,
      phone: parsed.query.phone,
      userId: parsed.query.userId,
      headers: req.headers
    };
    
    fs.appendFileSync(this.wsLog, JSON.stringify(entry) + '\n');
  }
  
  checkPortAvailable(port) {
    return new Promise((resolve, reject) => {
      const tester = net.createServer()
        .once('error', (err) => {
          if (err.code === 'EADDRINUSE') reject();
          else reject(err);
        })
        .once('listening', () => {
          tester.once('close', () => resolve()).close();
        })
        .listen(port);
    });
  }
  
  killProcessOnPort(port) {
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        execSync(`netstat -ano | findstr :${port}`, { stdio: 'pipe' });
        execSync(`taskkill /F /PID ${port}`, { stdio: 'pipe' });
      } else {
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' });
      }
    } catch (e) {
      // Ignore errors
    }
  }
  
  startBackendOnPort3001() {
    console.log('\n🚀 Starting your backend on port 3001...');
    
    // Set environment variable for backend
    process.env.PORT = this.backendPort;
    
    // Import and run your actual app.js
    try {
      const appPath = path.join(__dirname, 'app.js');
      if (fs.existsSync(appPath)) {
        require(appPath);
        console.log('✅ Backend started on port 3001');
      } else {
        console.error('❌ app.js not found at:', appPath);
        console.log('💡 Place mitm-proxy.js in your backend directory');
      }
    } catch (error) {
      console.error('❌ Failed to start backend:', error.message);
    }
  }
  
  printStats() {
    try {
      const wsMessages = fs.readFileSync(this.wsLog, 'utf8')
        .split('\n')
        .filter(line => line.trim());
      
      const decisions = fs.readFileSync(this.decisionLog, 'utf8')
        .split('\n')
        .filter(line => line.trim());
      
      console.log('\n📊 CAPTURE STATISTICS');
      console.log('='.repeat(50));
      console.log(`WebSocket Messages: ${wsMessages.length}`);
      console.log(`Decisions Captured: ${decisions.length}`);
      console.log(`Capture Directory: ${this.capturesDir}`);
      
      if (decisions.length > 0) {
        console.log('\n🎯 RECENT DECISIONS:');
        decisions.slice(-5).forEach(decision => {
          const d = JSON.parse(decision);
          console.log(`   ${new Date(d.timestamp).toLocaleTimeString()} - ${d.type} (${d.direction})`);
        });
      }
    } catch (e) {
      // Files might not exist yet
    }
  }
}

// Run if called directly
if (require.main === module) {
  const proxy = new MITMProxy();
  
  proxy.start().then(() => {
    console.log('\n✅ MITM Proxy is running!');
    console.log('💡 Use your Flutter app NORMALLY - no changes needed!');
    console.log('💡 All traffic is being captured...\n');
    
    // Print stats every 30 seconds
    setInterval(() => {
      proxy.printStats();
    }, 30000);
    
    // Handle Ctrl+C
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down MITM Proxy...');
      proxy.printStats();
      console.log(`📁 Check captures in: ${proxy.capturesDir}`);
      process.exit(0);
    });
  });
}

module.exports = MITMProxy;
