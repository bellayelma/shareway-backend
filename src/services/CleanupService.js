// services/CleanupService.js

const logger = require('../utils/Logger');

class CleanupService {
  constructor(firestoreService, admin) {
    this.firestore = firestoreService;
    this.admin = admin;
    this.batchSize = 500; // Firestore batch limit
    this.cleanupInterval = 24 * 60 * 60 * 1000; // Run once per day
    this.cleanupTimer = null;
    
    // Retention periods (in days)
    this.RETENTION = {
      TEMP_MATCHES: 7,           // Delete temporary matches after 7 days
      COMPLETED_RIDES: 90,        // Keep completed rides for 90 days
      CANCELLED_RIDES: 30,        // Keep cancelled rides for 30 days
      NOTIFICATIONS: 30,          // Keep notifications for 30 days
      SEARCH_HISTORY: 7,          // Keep scheduled searches for 7 days after completion
      
      // Aggregated data (keep forever but summarized)
      USER_STATS: null,           // Keep forever
      RIDE_SUMMARIES: 365         // Keep summaries for 1 year
    };
  }

  /**
   * Start the cleanup scheduler
   */
  start() {
    logger.info('CLEANUP', '🚀 Starting cleanup service - runs daily at 3 AM');
    
    // Calculate next run at 3 AM
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(3, 0, 0, 0);
    
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }
    
    const delay = nextRun.getTime() - now.getTime();
    
    // Schedule first run
    setTimeout(() => {
      this.performCleanup();
      
      // Then run every 24 hours
      this.cleanupTimer = setInterval(() => {
        this.performCleanup();
      }, 24 * 60 * 60 * 1000);
    }, delay);
    
    logger.info('CLEANUP', `📅 Next cleanup scheduled for: ${nextRun.toISOString()}`);
  }

  /**
   * Stop the cleanup service
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    logger.info('CLEANUP', '🛑 Cleanup service stopped');
  }

  /**
   * Perform all cleanup operations
   */
  async performCleanup() {
    const startTime = Date.now();
    logger.info('CLEANUP', '🧹 Starting daily cleanup...');
    
    const results = {
      tempMatches: 0,
      completedRides: 0,
      cancelledRides: 0,
      oldSearches: 0,
      notifications: 0,
      archivedRides: 0,
      errors: []
    };
    
    try {
      // Run cleanups in parallel but with rate limiting
      await Promise.allSettled([
        this.cleanupTemporaryMatches().then(count => results.tempMatches = count),
        this.cleanupOldRides().then(count => results.completedRides = count),
        this.cleanupCancelledRides().then(count => results.cancelledRides = count),
        this.cleanupOldSearches().then(count => results.oldSearches = count),
        this.cleanupNotifications().then(count => results.notifications = count),
        this.archiveOldRides().then(count => results.archivedRides = count)
      ]);
      
      // After cleanup, update aggregated stats
      await this.updateAggregatedStats();
      
      const duration = Date.now() - startTime;
      
      logger.info('CLEANUP', '✅ Cleanup completed', {
        duration: `${duration}ms`,
        ...results
      });
      
      // Log cleanup results to Firestore for monitoring
      await this.logCleanupResults(results, duration);
      
    } catch (error) {
      logger.error('CLEANUP', `❌ Cleanup failed: ${error.message}`);
      results.errors.push(error.message);
    }
    
    return results;
  }

  // ========== SPECIFIC CLEANUP OPERATIONS ==========

  /**
   * Clean up temporary matches (expired, rejected, etc.)
   */
  async cleanupTemporaryMatches() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.RETENTION.TEMP_MATCHES);
    
    logger.info('CLEANUP', `🗑️ Cleaning temporary matches older than ${cutoffDate.toISOString()}`);
    
    let deletedCount = 0;
    let lastDoc = null;
    
    while (true) {
      // Query expired matches
      const query = this.firestore.firestore
        .collection('scheduled_matches')
        .where('status', 'in', ['expired', 'rejected', 'cancelled'])
        .where('updatedAt', '<', cutoffDate.toISOString())
        .limit(this.batchSize);
      
      const snapshot = await query.get();
      
      if (snapshot.empty) break;
      
      // Delete in batch
      const batch = this.firestore.firestore.batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
        deletedCount++;
      });
      
      await batch.commit();
      logger.info('CLEANUP', `Deleted ${snapshot.size} temporary matches`);
      
      if (snapshot.size < this.batchSize) break;
    }
    
    return deletedCount;
  }

  /**
   * Clean up old completed rides (but keep summaries)
   */
  async cleanupOldRides() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.RETENTION.COMPLETED_RIDES);
    
    logger.info('CLEANUP', `🗑️ Archiving rides completed before ${cutoffDate.toISOString()}`);
    
    let archivedCount = 0;
    let lastDoc = null;
    
    while (true) {
      const query = this.firestore.firestore
        .collection('rides')
        .where('status', 'in', ['completed', 'completed_with_feedback'])
        .where('updatedAt', '<', cutoffDate.toISOString())
        .limit(this.batchSize);
      
      const snapshot = await query.get();
      
      if (snapshot.empty) break;
      
      // Before deleting, create summaries in archive collection
      const batch = this.firestore.firestore.batch();
      
      for (const doc of snapshot.docs) {
        const rideData = doc.data();
        
        // Create summary for archive
        const summaryRef = this.firestore.firestore
          .collection('ride_archive')
          .doc(doc.id);
        
        batch.set(summaryRef, {
          rideId: doc.id,
          driver: {
            phone: rideData.driver?.phone,
            name: rideData.driver?.name
          },
          passenger: {
            phone: rideData.passenger?.phone,
            name: rideData.passenger?.name
          },
          trip: {
            date: rideData.trip?.scheduledTime,
            pickup: rideData.trip?.pickup?.name,
            destination: rideData.trip?.destination?.name,
            distance: rideData.trip?.route?.distance,
            duration: rideData.trip?.route?.duration
          },
          payment: {
            amount: rideData.payment?.fare?.actual || rideData.payment?.fare?.estimated,
            method: rideData.payment?.method
          },
          feedback: rideData.feedback,
          archivedAt: new Date().toISOString()
        });
        
        // Delete original
        batch.delete(doc.ref);
        archivedCount++;
      }
      
      await batch.commit();
      logger.info('CLEANUP', `Archived ${snapshot.size} rides`);
      
      if (snapshot.size < this.batchSize) break;
    }
    
    return archivedCount;
  }

  /**
   * Clean up cancelled rides faster
   */
  async cleanupCancelledRides() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.RETENTION.CANCELLED_RIDES);
    
    logger.info('CLEANUP', `🗑️ Cleaning cancelled rides older than ${cutoffDate.toISOString()}`);
    
    let deletedCount = 0;
    
    while (true) {
      const query = this.firestore.firestore
        .collection('rides')
        .where('status', 'in', ['cancelled_by_driver', 'cancelled_by_passenger', 'no_show'])
        .where('updatedAt', '<', cutoffDate.toISOString())
        .limit(this.batchSize);
      
      const snapshot = await query.get();
      
      if (snapshot.empty) break;
      
      const batch = this.firestore.firestore.batch();
      snapshot.docs.forEach(doc => {
        // For cancelled rides, just delete - no need to archive
        batch.delete(doc.ref);
        deletedCount++;
      });
      
      await batch.commit();
      
      if (snapshot.size < this.batchSize) break;
    }
    
    return deletedCount;
  }

  /**
   * Clean up old scheduled searches
   */
  async cleanupOldSearches() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.RETENTION.SEARCH_HISTORY);
    
    logger.info('CLEANUP', `🗑️ Cleaning old searches before ${cutoffDate.toISOString()}`);
    
    const collections = [
      'scheduled_searches_driver',
      'scheduled_searches_passenger'
    ];
    
    let totalDeleted = 0;
    
    for (const collection of collections) {
      let lastDoc = null;
      
      while (true) {
        const query = this.firestore.firestore
          .collection(collection)
          .where('status', 'in', ['cancelled', 'completed', 'expired'])
          .where('updatedAt', '<', cutoffDate.toISOString())
          .limit(this.batchSize);
        
        const snapshot = await query.get();
        
        if (snapshot.empty) break;
        
        const batch = this.firestore.firestore.batch();
        snapshot.docs.forEach(doc => {
          batch.delete(doc.ref);
          totalDeleted++;
        });
        
        await batch.commit();
        
        if (snapshot.size < this.batchSize) break;
      }
    }
    
    return totalDeleted;
  }

  /**
   * Clean up old notifications
   */
  async cleanupNotifications() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.RETENTION.NOTIFICATIONS);
    
    let deletedCount = 0;
    
    while (true) {
      const query = this.firestore.firestore
        .collection('notifications')
        .where('createdAt', '<', cutoffDate.toISOString())
        .limit(this.batchSize);
      
      const snapshot = await query.get();
      
      if (snapshot.empty) break;
      
      const batch = this.firestore.firestore.batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
        deletedCount++;
      });
      
      await batch.commit();
      
      if (snapshot.size < this.batchSize) break;
    }
    
    return deletedCount;
  }

  /**
   * Archive old rides to cold storage (Firestore archive collection)
   */
  async archiveOldRides() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 365); // Archive after 1 year
    
    let archivedCount = 0;
    
    const query = this.firestore.firestore
      .collection('rides')
      .where('updatedAt', '<', cutoffDate.toISOString())
      .limit(this.batchSize);
    
    const snapshot = await query.get();
    
    if (snapshot.empty) return 0;
    
    const batch = this.firestore.firestore.batch();
    
    for (const doc of snapshot.docs) {
      const rideData = doc.data();
      
      // Create minimal archive record
      const archiveRef = this.firestore.firestore
        .collection('ride_archive_cold')
        .doc(doc.id);
      
      batch.set(archiveRef, {
        ...rideData,
        archivedAt: new Date().toISOString(),
        originalId: doc.id
      });
      
      batch.delete(doc.ref);
      archivedCount++;
    }
    
    await batch.commit();
    
    return archivedCount;
  }

  // ========== AGGREGATION AND SUMMARIZATION ==========

  /**
   * Update aggregated stats for users (keep forever but summarized)
   */
  async updateAggregatedStats() {
    logger.info('CLEANUP', '📊 Updating aggregated user stats...');
    
    // Get all users with rides in the last 90 days
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    
    const users = new Set();
    
    // Find recent rides to update stats
    const ridesQuery = await this.firestore.firestore
      .collection('rides')
      .where('updatedAt', '>', ninetyDaysAgo.toISOString())
      .get();
    
    // Collect unique users
    ridesQuery.docs.forEach(doc => {
      const data = doc.data();
      if (data.driver?.phone) users.add(data.driver.phone);
      if (data.passenger?.phone) users.add(data.passenger.phone);
    });
    
    // Update stats for each user
    const batch = this.firestore.firestore.batch();
    let updatedCount = 0;
    
    for (const phone of users) {
      const stats = await this.calculateUserStats(phone);
      
      const userRef = this.firestore.firestore
        .collection('users')
        .doc(this.sanitizePhoneNumber(phone));
      
      batch.set(userRef, {
        stats: {
          totalRides: stats.totalRides,
          totalSpent: stats.totalSpent,
          totalEarned: stats.totalEarned,
          averageRating: stats.averageRating,
          lastUpdated: new Date().toISOString()
        }
      }, { merge: true });
      
      updatedCount++;
      
      // Commit every 500 updates
      if (updatedCount % 500 === 0) {
        await batch.commit();
        logger.info('CLEANUP', `Updated stats for ${updatedCount} users`);
      }
    }
    
    if (updatedCount % 500 !== 0) {
      await batch.commit();
    }
    
    logger.info('CLEANUP', `✅ Updated stats for ${updatedCount} users`);
  }

  /**
   * Calculate user statistics from rides
   */
  async calculateUserStats(phoneNumber) {
    const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
    
    // Query all rides for this user (including archived)
    const [activeRides, archivedRides] = await Promise.all([
      this.firestore.firestore
        .collection('rides')
        .where('driver.phone', '==', phoneNumber)
        .get(),
      this.firestore.firestore
        .collection('ride_archive')
        .where('driver.phone', '==', phoneNumber)
        .get()
    ]);
    
    const allRides = [...activeRides.docs, ...archivedRides.docs];
    
    let totalRides = 0;
    let totalSpent = 0;
    let totalEarned = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    
    allRides.forEach(doc => {
      const ride = doc.data();
      totalRides++;
      
      // Financial stats
      if (ride.payment?.fare?.actual) {
        if (ride.passenger?.phone === phoneNumber) {
          totalSpent += ride.payment.fare.actual;
        }
        if (ride.driver?.phone === phoneNumber) {
          totalEarned += ride.payment.fare.actual;
        }
      }
      
      // Ratings
      if (ride.feedback) {
        if (ride.passenger?.phone === phoneNumber && ride.feedback.passengerRating) {
          ratingSum += ride.feedback.passengerRating;
          ratingCount++;
        }
        if (ride.driver?.phone === phoneNumber && ride.feedback.driverRating) {
          ratingSum += ride.feedback.driverRating;
          ratingCount++;
        }
      }
    });
    
    return {
      totalRides,
      totalSpent,
      totalEarned,
      averageRating: ratingCount > 0 ? ratingSum / ratingCount : 0,
      ratingCount
    };
  }

  // ========== MANUAL CLEANUP TRIGGERS ==========

  /**
   * Manually trigger cleanup for a specific user
   */
  async cleanupUserData(phoneNumber) {
    logger.info('CLEANUP', `🧹 Manual cleanup for user: ${phoneNumber}`);
    
    const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
    const results = {
      searches: 0,
      notifications: 0,
      matches: 0
    };
    
    // Clean up old searches
    const searchesQuery = await this.firestore.firestore
      .collectionGroup('scheduled_searches')
      .where('userId', '==', phoneNumber)
      .where('status', 'in', ['cancelled', 'expired'])
      .get();
    
    const batch = this.firestore.firestore.batch();
    searchesQuery.docs.forEach(doc => {
      batch.delete(doc.ref);
      results.searches++;
    });
    
    // Clean up old notifications
    const notificationsQuery = await this.firestore.firestore
      .collection('notifications')
      .where('userId', '==', phoneNumber)
      .where('createdAt', '<', this.getDateDaysAgo(30).toISOString())
      .get();
    
    notificationsQuery.docs.forEach(doc => {
      batch.delete(doc.ref);
      results.notifications++;
    });
    
    if (results.searches > 0 || results.notifications > 0) {
      await batch.commit();
    }
    
    // Update user stats
    await this.updateAggregatedStats();
    
    return results;
  }

  /**
   * Get size of collections for monitoring
   */
  async getCollectionStats() {
    const stats = {};
    
    const collections = [
      'rides',
      'scheduled_matches',
      'scheduled_searches_driver',
      'scheduled_searches_passenger',
      'notifications',
      'ride_archive'
    ];
    
    for (const collection of collections) {
      const snapshot = await this.firestore.firestore
        .collection(collection)
        .limit(1000)
        .get();
      
      // Get count (approximate)
      const countQuery = await this.firestore.firestore
        .collection(collection)
        .count()
        .get();
      
      stats[collection] = {
        approximateCount: countQuery.data().count,
        sample: snapshot.size
      };
    }
    
    // Get old data counts
    const thirtyDaysAgo = this.getDateDaysAgo(30).toISOString();
    
    for (const collection of collections) {
      const oldQuery = await this.firestore.firestore
        .collection(collection)
        .where('updatedAt', '<', thirtyDaysAgo)
        .limit(1000)
        .count()
        .get();
      
      stats[`${collection}_old`] = oldQuery.data().count;
    }
    
    return stats;
  }

  // ========== HELPER METHODS ==========

  sanitizePhoneNumber(phone) {
    return phone.replace(/\D/g, '');
  }

  getDateDaysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }

  async logCleanupResults(results, duration) {
    await this.firestore.firestore
      .collection('cleanup_logs')
      .add({
        timestamp: new Date().toISOString(),
        duration,
        results,
        success: results.errors.length === 0
      });
  }
}

module.exports = CleanupService;
