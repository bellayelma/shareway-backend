const { MAX_LOG_ENTRIES_PER_REQUEST } = require('../config/constants');

// Store request counts per minute to prevent log spam
const requestLogs = new Map();

const shouldLogRequest = (method, url) => {
  const now = Date.now();
  const minuteKey = Math.floor(now / 60000);
  
  const key = `${method}:${url}:${minuteKey}`;
  const count = requestLogs.get(key) || 0;
  
  if (count < MAX_LOG_ENTRIES_PER_REQUEST) {
    requestLogs.set(key, count + 1);
    return true;
  }
  
  // Log only every 10th request after limit
  if (count % 10 === 0) {
    requestLogs.set(key, count + 1);
    return true;
  }
  
  requestLogs.set(key, count + 1);
  return false;
};

// Clean up old logs every 5 minutes
setInterval(() => {
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60000);
  const oldMinuteKey = Math.floor(fiveMinutesAgo / 60000);
  
  for (const [key] of requestLogs.entries()) {
    const keyMinute = parseInt(key.split(':').pop());
    if (keyMinute < oldMinuteKey) {
      requestLogs.delete(key);
    }
  }
}, 300000);

module.exports = (req, res, next) => {
  const shouldLog = shouldLogRequest(req.method, req.url);
  
  if (shouldLog) {
    console.log(`🔍 ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url}`);
    
    if (req.method === 'POST' && Object.keys(req.body).length > 0) {
      const logBody = {};
      const keys = Object.keys(req.body);
      
      keys.slice(0, 3).forEach(key => {
        if (typeof req.body[key] !== 'object' || req.body[key] === null) {
          logBody[key] = req.body[key];
        } else {
          logBody[key] = `[Object with ${Object.keys(req.body[key]).length} keys]`;
        }
      });
      
      if (keys.length > 3) {
        logBody['...'] = `${keys.length - 3} more keys`;
      }
      
      console.log('📦 Body:', JSON.stringify(logBody).slice(0, 200));
    }
  }
  
  next();
};
