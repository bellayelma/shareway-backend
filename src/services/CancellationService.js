// services/CancellationService.js
const logger = require('../utils/Logger');

class CancellationService {
  constructor(firestoreService, websocketServer, admin) {
    this.db = admin.firestore();
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.CANCELLATIONS = 'cancellations';
    this.NOTIFICATIONS = 'notifications';
  }

  /**
   * Create cancellation document and notify relevant users
   */
  async createCancellationRecord(cancellationData) {
    try {
      const cancellationRef = this.db.collection(this.CANCELLATIONS).doc();
      const cancellationId = cancellationRef.id;
      
      // Add cancellation ID to data
      const fullCancellationData = {
        ...cancellationData,
        cancellationId,
        createdAt: new Date().toISOString(),
        readBy: {},
        acknowledgedBy: {},
        websocket: {
          broadcasted: false,
          broadcastChannels: this.getBroadcastChannels(cancellationData)
        }
      };
      
      // Set notifyUsers if not present
      if (!fullCancellationData.notifyUsers) {
        fullCancellationData.notifyUsers = this.getNotifyUsers(cancellationData);
      }
      
      // Set UI data for Flutter screens
      if (!fullCancellationData.uiData) {
        fullCancellationData.uiData = this.generateUIData(cancellationData);
      }
      
      // Save to Firestore
      await cancellationRef.set(fullCancellationData);
      
      logger.info('CANCELLATION', `Created cancellation record: ${cancellationId}`);
      
      // Broadcast via WebSocket in real-time
      await this.broadcastCancellation(cancellationId, fullCancellationData);
      
      // Create notifications for offline users
      await this.createUserNotifications(cancellationId, fullCancellationData);
      
      return {
        success: true,
        cancellationId,
        data: fullCancellationData
      };
      
    } catch (error) {
      logger.error('CANCELLATION', 'Error creating cancellation record:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get broadcast channels based on cancellation type
   */
  getBroadcastChannels(data) {
    const channels = [];
    
    switch (data.cancellationType) {
      case 'driver_cancelled_all':
        // Broadcast to all affected passengers
        if (data.originalTrip?.affectedPassengers) {
          data.originalTrip.affectedPassengers.forEach(p => {
            channels.push(`passenger_${p.phone}`);
          });
        }
        channels.push(`driver_${data.cancelledBy}`);
        break;
        
      case 'driver_cancelled_passenger':
        channels.push(`passenger_${data.passengerDetails.phone}`);
        channels.push(`driver_${data.cancelledBy}`);
        break;
        
      case 'passenger_cancelled':
        channels.push(`driver_${data.driverDetails.phone}`);
        channels.push(`passenger_${data.cancelledBy}`);
        break;
    }
    
    return channels;
  }

  /**
   * Generate UI data for Flutter screens
   */
  generateUIData(data) {
    const uiData = {
      screenTitle: '',
      icon: '',
      primaryMessage: '',
      secondaryMessage: '',
      actionButtons: []
    };
    
    switch (data.cancellationType) {
      case 'passenger_cancelled':
        uiData.screenTitle = 'Ride Cancelled';
        uiData.icon = 'cancel';
        uiData.primaryMessage = `${data.passengerDetails?.name || 'A passenger'} has cancelled their ride`;
        uiData.secondaryMessage = `Trip to ${data.originalTrip?.destinationName || 'destination'} has been cancelled`;
        uiData.actionButtons = [
          {
            label: 'Find New Passengers',
            action: 'navigate_to_matching',
            icon: 'search',
            data: {
              scheduleId: data.originalTrip?.scheduleId,
              availableSeats: data.afterCancellation?.driverAvailableSeats
            }
          },
          {
            label: 'Close',
            action: 'dismiss',
            icon: 'close'
          }
        ];
        break;
        
      case 'driver_cancelled_passenger':
        uiData.screenTitle = 'Ride Cancelled by Driver';
        uiData.icon = 'warning';
        uiData.primaryMessage = `Your ride with ${data.driverDetails?.name || 'driver'} has been cancelled`;
        uiData.secondaryMessage = `Trip to ${data.originalTrip?.destinationName || 'destination'}`;
        uiData.actionButtons = [
          {
            label: 'Find New Driver',
            action: 'navigate_to_schedule',
            icon: 'schedule',
            data: {
              originalBooking: data.originalTrip?.bookingId
            }
          },
          {
            label: 'Close',
            action: 'dismiss',
            icon: 'close'
          }
        ];
        break;
        
      case 'driver_cancelled_all':
        uiData.screenTitle = 'Trip Cancelled by Driver';
        uiData.icon = 'error';
        uiData.primaryMessage = `${data.driverDetails?.name || 'Driver'} has cancelled the entire trip`;
        uiData.secondaryMessage = `All passengers need to find alternative transportation`;
        uiData.actionButtons = [
          {
            label: 'Schedule New Ride',
            action: 'navigate_to_schedule',
            icon: 'schedule',
            data: {
              suggested: true
            }
          },
          {
            label: 'Close',
            action: 'dismiss',
            icon: 'close'
          }
        ];
        break;
    }
    
    return uiData;
  }

  /**
   * Get list of users to notify
   */
  getNotifyUsers(data) {
    const users = [];
    
    switch (data.cancellationType) {
      case 'driver_cancelled_all':
        if (data.originalTrip?.affectedPassengers) {
          data.originalTrip.affectedPassengers.forEach(p => {
            users.push({
              phone: p.phone,
              role: 'passenger',
              notified: false
            });
          });
        }
        users.push({
          phone: data.cancelledBy,
          role: 'driver',
          notified: false
        });
        break;
        
      case 'driver_cancelled_passenger':
        users.push({
          phone: data.passengerDetails.phone,
          role: 'passenger',
          notified: false
        });
        users.push({
          phone: data.cancelledBy,
          role: 'driver',
          notified: false
        });
        break;
        
      case 'passenger_cancelled':
        users.push({
          phone: data.driverDetails.phone,
          role: 'driver',
          notified: false
        });
        users.push({
          phone: data.cancelledBy,
          role: 'passenger',
          notified: false
        });
        break;
    }
    
    return users;
  }

  /**
   * Broadcast cancellation via WebSocket
   */
  async broadcastCancellation(cancellationId, cancellationData) {
    try {
      if (!this.websocketServer) return false;
      
      const broadcastData = {
        type: 'CANCELLATION',
        subtype: cancellationData.cancellationType,
        cancellationId,
        data: cancellationData,
        timestamp: new Date().toISOString()
      };
      
      // Broadcast to specific channels
      for (const channel of cancellationData.websocket.broadcastChannels) {
        await this.websocketServer.sendToChannel(channel, broadcastData);
      }
      
      // Also broadcast to general channel for any listeners
      await this.websocketServer.broadcast('cancellations', {
        ...broadcastData,
        isPublic: true
      });
      
      // Update broadcast status
      await this.db.collection(this.CANCELLATIONS).doc(cancellationId).update({
        'websocket.broadcasted': true,
        'websocket.broadcastedAt': new Date().toISOString()
      });
      
      logger.info('CANCELLATION', `Broadcasted cancellation ${cancellationId} to ${cancellationData.websocket.broadcastChannels.length} channels`);
      
      return true;
      
    } catch (error) {
      logger.error('CANCELLATION', 'Error broadcasting cancellation:', error);
      return false;
    }
  }

  /**
   * Create notifications for offline users
   */
  async createUserNotifications(cancellationId, cancellationData) {
    try {
      const notifications = [];
      
      for (const user of cancellationData.notifyUsers) {
        if (user.role === cancellationData.cancelledByRole) continue; // Skip who cancelled
        
        const notificationData = {
          userId: user.phone,
          type: 'CANCELLATION',
          subtype: cancellationData.cancellationType,
          cancellationId,
          title: cancellationData.uiData.screenTitle,
          body: cancellationData.uiData.primaryMessage,
          data: {
            cancellationId,
            uiData: cancellationData.uiData,
            driverDetails: cancellationData.driverDetails,
            passengerDetails: cancellationData.passengerDetails,
            originalTrip: cancellationData.originalTrip,
            actionButtons: cancellationData.uiData.actionButtons
          },
          read: false,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        };
        
        const notifRef = await this.db.collection(this.NOTIFICATIONS).add(notificationData);
        notifications.push(notifRef.id);
      }
      
      logger.info('CANCELLATION', `Created ${notifications.length} notifications for cancellation ${cancellationId}`);
      
      return notifications;
      
    } catch (error) {
      logger.error('CANCELLATION', 'Error creating notifications:', error);
      return [];
    }
  }

  /**
   * Get cancellation for a user
   */
  async getUserCancellations(userPhone, limit = 20, includeRead = false) {
    try {
      let query = this.db.collection(this.CANCELLATIONS)
        .where('notifyUsers', 'array-contains', { phone: userPhone })
        .orderBy('createdAt', 'desc')
        .limit(limit);
      
      if (!includeRead) {
        query = query.where(`readBy.${userPhone}`, '==', false);
      }
      
      const snapshot = await query.get();
      
      const cancellations = [];
      snapshot.forEach(doc => {
        cancellations.push({
          id: doc.id,
          ...doc.data()
        });
      });
      
      return {
        success: true,
        cancellations,
        count: cancellations.length
      };
      
    } catch (error) {
      logger.error('CANCELLATION', 'Error getting user cancellations:', error);
      return { success: false, error: error.message, cancellations: [] };
    }
  }

  /**
   * Mark cancellation as read by user
   */
  async markAsRead(cancellationId, userPhone) {
    try {
      await this.db.collection(this.CANCELLATIONS).doc(cancellationId).update({
        [`readBy.${userPhone}`]: true,
        [`readBy.${userPhone}At`]: new Date().toISOString()
      });
      
      return { success: true };
    } catch (error) {
      logger.error('CANCELLATION', 'Error marking as read:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Acknowledge cancellation (user has seen and acted)
   */
  async acknowledgeCancellation(cancellationId, userPhone, action) {
    try {
      await this.db.collection(this.CANCELLATIONS).doc(cancellationId).update({
        [`acknowledgedBy.${userPhone}`]: true,
        [`acknowledgedBy.${userPhone}At`]: new Date().toISOString(),
        [`acknowledgedBy.${userPhone}Action`]: action
      });
      
      return { success: true };
    } catch (error) {
      logger.error('CANCELLATION', 'Error acknowledging cancellation:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get single cancellation by ID
   */
  async getCancellation(cancellationId) {
    try {
      const doc = await this.db.collection(this.CANCELLATIONS).doc(cancellationId).get();
      
      if (!doc.exists) {
        return { success: false, error: 'Cancellation not found' };
      }
      
      return {
        success: true,
        cancellation: {
          id: doc.id,
          ...doc.data()
        }
      };
    } catch (error) {
      logger.error('CANCELLATION', 'Error getting cancellation:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = CancellationService;
