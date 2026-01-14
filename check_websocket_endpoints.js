#!/usr/bin/env node
const http = require('http');
const WebSocket = require('ws');

const CONFIG = {
  hostname: 'localhost',
  port: 3000
};

async function diagnose() {
  console.log('🔍 DIAGNOSING BACKEND STRUCTURE\n');
  
  // 1. Check health endpoint
  console.log('1. Checking health endpoint...');
  await checkHealth();
  
  // 2. Test search endpoint with minimal data
  console.log('\n2. Testing search endpoint...');
  await testSearch();
  
  // 3. Check WebSocket with proper handshake
  console.log('\n3. Testing WebSocket connection...');
  await testWebSocket();
  
  // 4. Check location endpoints
  console.log('\n4. Checking location endpoints...');
  await checkLocationEndpoints();
}

async function checkHealth() {
  return new Promise((resolve) => {
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: '/api/health',
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log(`   ✅ Status: ${res.statusCode}`);
          console.log(`   📊 Data: ${JSON.stringify(json)}`);
        } catch {
          console.log(`   ⚠️ Status: ${res.statusCode}, Raw: ${data}`);
        }
        resolve();
      });
    });
    
    req.on('error', (error) => {
      console.log(`   ❌ Error: ${error.message}`);
      resolve();
    });
    
    req.end();
  });
}

async function testSearch() {
  // Minimal search data
  const searchData = {
    userId: '+251911233344',
    userType: 'passenger',
    rideType: 'immediate',
    passengerName: 'Test Passenger',
    passengerPhone: '+251911233344',
    pickup: {
      address: 'Adama',
      location: { lat: 8.549995, lng: 39.266714 }
    },
    dropoff: {
      address: 'Dire Dawa',
      location: { lat: 9.589549, lng: 41.866169 }
    },
    numberOfPassengers: 1
  };
  
  return new Promise((resolve) => {
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: '/api/match/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`   📤 Sent search for: ${searchData.passengerName}`);
        console.log(`   📥 Response: Status ${res.statusCode}`);
        
        if (res.statusCode !== 200) {
          console.log(`   ❌ Failed with status: ${res.statusCode}`);
          if (data) {
            try {
              const error = JSON.parse(data);
              console.log(`   💡 Error message: ${error.error || JSON.stringify(error)}`);
            } catch {
              console.log(`   💡 Raw error: ${data.substring(0, 200)}`);
            }
          }
        } else {
          try {
            const result = JSON.parse(data);
            console.log(`   ✅ Success!`);
            console.log(`   📊 Result: ${JSON.stringify(result, null, 2).substring(0, 300)}...`);
            
            // Check for WebSocket info
            if (result.websocketUrl || result.wsUrl) {
              console.log(`   🔌 WebSocket URL: ${result.websocketUrl || result.wsUrl}`);
            }
          } catch {
            console.log(`   ⚠️ Could not parse response: ${data.substring(0, 200)}`);
          }
        }
        resolve();
      });
    });
    
    req.on('error', (error) => {
      console.log(`   ❌ Request error: ${error.message}`);
      resolve();
    });
    
    req.write(JSON.stringify(searchData));
    req.end();
  });
}

async function testWebSocket() {
  console.log('   Trying WebSocket connection to ws://localhost:3000...');
  
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3000');
    
    const timeout = setTimeout(() => {
      console.log('   ⏱️ Timeout waiting for connection');
      ws.close();
      resolve();
    }, 5000);
    
    ws.on('open', () => {
      clearTimeout(timeout);
      console.log('   ✅ WebSocket connected successfully!');
      console.log('   📤 Sending test message...');
      
      ws.send(JSON.stringify({
        type: 'test',
        message: 'Hello from diagnosis script',
        timestamp: Date.now()
      }));
      
      setTimeout(() => {
        ws.close();
        resolve();
      }, 2000);
    });
    
    ws.on('message', (data) => {
      console.log(`   📥 Received: ${data.toString().substring(0, 100)}`);
    });
    
    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.log(`   ❌ WebSocket error: ${error.message}`);
      resolve();
    });
    
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log(`   🔌 WebSocket closed: code=${code}, reason=${reason}`);
      resolve();
    });
  });
}

async function checkLocationEndpoints() {
  const endpoints = [
    '/api/location/update',
    '/api/location/passenger/update',
    '/api/driver/update-location',
    '/api/passenger/update-location'
  ];
  
  for (const endpoint of endpoints) {
    await new Promise(resolve => {
      const options = {
        hostname: CONFIG.hostname,
        port: CONFIG.port,
        path: endpoint,
        method: 'GET'
      };
      
      const req = http.request(options, (res) => {
        console.log(`   ${endpoint}: ${res.statusCode}`);
        resolve();
      });
      
      req.on('error', () => {
        console.log(`   ${endpoint}: ❌ Not reachable`);
        resolve();
      });
      
      req.end();
    });
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

diagnose().catch(console.error);
