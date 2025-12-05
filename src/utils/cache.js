class Cache {
  constructor() {
    this.store = new Map();
    this.ttlStore = new Map();
  }
  
  set(key, value, ttl = 60000) {
    this.store.set(key, value);
    this.ttlStore.set(key, Date.now() + ttl);
    return true;
  }
  
  get(key) {
    const ttl = this.ttlStore.get(key);
    if (ttl && Date.now() > ttl) {
      this.del(key);
      return null;
    }
    return this.store.get(key);
  }
  
  del(key) {
    this.store.delete(key);
    this.ttlStore.delete(key);
    return true;
  }
  
  has(key) {
    const ttl = this.ttlStore.get(key);
    if (ttl && Date.now() > ttl) {
      this.del(key);
      return false;
    }
    return this.store.has(key);
  }
  
  clear() {
    this.store.clear();
    this.ttlStore.clear();
  }
  
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, ttl] of this.ttlStore.entries()) {
      if (now > ttl) {
        this.del(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cache cleanup: removed ${cleaned} expired entries`);
    }
  }
  
  stats() {
    return {
      size: this.store.size,
      ttlCount: this.ttlStore.size
    };
  }
}

module.exports = new Cache();
