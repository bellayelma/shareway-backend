// This would handle WebSocket notifications
// For now, we'll keep it simple and use the WebSocketServer directly

module.exports = {
  sendMatchProposal: (websocketServer, userId, data) => {
    if (websocketServer && websocketServer.isUserConnected(userId)) {
      websocketServer.sendMatchProposal(userId, data);
      return true;
    }
    return false;
  },
  
  sendMatchAccepted: (websocketServer, userId, data) => {
    if (websocketServer && websocketServer.isUserConnected(userId)) {
      websocketServer.sendMatchAccepted(userId, data);
      return true;
    }
    return false;
  },
  
  sendMatchExpired: (websocketServer, userId, data) => {
    if (websocketServer && websocketServer.isUserConnected(userId)) {
      websocketServer.sendMatchExpired(userId, data);
      return true;
    }
    return false;
  },
  
  sendSearchStopped: (websocketServer, userId, data) => {
    if (websocketServer && websocketServer.isUserConnected(userId)) {
      websocketServer.sendSearchStopped(userId, data);
      return true;
    }
    return false;
  },
  
  sendSearchTimeout: (websocketServer, userId, data) => {
    if (websocketServer && websocketServer.isUserConnected(userId)) {
      websocketServer.sendSearchTimeout(userId, data);
      return true;
    }
    return false;
  }
};
