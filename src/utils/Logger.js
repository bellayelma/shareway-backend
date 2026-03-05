// src/utils/Logger.js
class Logger {
  constructor() {
    this.levels = {
      ERROR: 0,
      WARN: 1,
      INFO: 2,
      DEBUG: 3
    };
    
    this.currentLevel = this.levels.INFO;
    this.enabledModules = {
      MATCHING: true,
      WEBSOCKET: true,
      DATABASE: false,
      LOCATION: false,
      SCHEDULED: false,
      REQUESTS: true,
      RESPONSES: true,
      ERRORS: true,
      STARTUP: true,
      CONFIG: true
    };
    
    this.colors = {
      reset: '\x1b[0m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      gray: '\x1b[90m'
    };
  }

  setLevel(level) {
    this.currentLevel = this.levels[level] || this.levels.INFO;
  }

  enableModule(module, enabled = true) {
    if (this.enabledModules.hasOwnProperty(module)) {
      this.enabledModules[module] = enabled;
    }
  }

  error(module, message, data = null) {
    if (this.currentLevel >= this.levels.ERROR && this.enabledModules.ERRORS) {
      this._log('ERROR', module, this.colors.red, message, data);
    }
  }

  warn(module, message, data = null) {
    if (this.currentLevel >= this.levels.WARN) {
      this._log('WARN', module, this.colors.yellow, message, data);
    }
  }

  info(module, message, data = null) {
    if (this.currentLevel >= this.levels.INFO) {
      this._log('INFO', module, this.colors.green, message, data);
    }
  }

  debug(module, message, data = null) {
    if (this.currentLevel >= this.levels.DEBUG) {
      this._log('DEBUG', module, this.colors.blue, message, data);
    }
  }

  request(method, url, body = null) {
    if (this.enabledModules.REQUESTS) {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`${this.colors.cyan}📥 ${timestamp} ${method} ${url}${this.colors.reset}`);
      if (body && Object.keys(body).length > 0) {
        const bodySummary = this._summarizeBody(body);
        console.log(`${this.colors.gray}   Body: ${bodySummary}${this.colors.reset}`);
      }
    }
  }

  response(method, url, statusCode, data = null) {
    if (this.enabledModules.RESPONSES) {
      const timestamp = new Date().toLocaleTimeString();
      const color = statusCode >= 400 ? this.colors.red : 
                   statusCode >= 300 ? this.colors.yellow : this.colors.green;
      console.log(`${color}📤 ${timestamp} ${method} ${url} → ${statusCode}${this.colors.reset}`);
      if (data && Object.keys(data).length > 0) {
        console.log(`${this.colors.gray}   Response keys: ${Object.keys(data).join(', ')}${this.colors.reset}`);
      }
    }
  }

  _log(level, module, color, message, data) {
    if (!this.enabledModules[module]) return;
    
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `${color}[${level}]${this.colors.reset} ${this.colors.gray}[${module}]${this.colors.reset}`;
    
    console.log(`${timestamp} ${prefix} ${message}`);
    
    if (data && level === 'ERROR') {
      console.error(`${this.colors.red}   ${JSON.stringify(data, null, 2)}${this.colors.reset}`);
    } else if (data && this.currentLevel >= this.levels.DEBUG) {
      console.log(`${this.colors.gray}   ${JSON.stringify(data, null, 2)}${this.colors.reset}`);
    }
  }

  _summarizeBody(body) {
    const keys = Object.keys(body);
    if (keys.length <= 5) {
      return JSON.stringify(body);
    }
    return `{${keys.slice(0, 3).join(', ')}, ... (${keys.length - 3} more keys)}`;
  }
}

module.exports = new Logger();
