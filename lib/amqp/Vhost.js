var debug = require('debug')('rascal:Vhost');
var format = require('util').format;
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var async = require('async');
var forwardEvents = require('forward-emitter');
var genericPool = require('generic-pool');
var tasks = require('./tasks');
var uuid = require('uuid').v4;
var _ = require('lodash');
var backoff = require('../backoff');

module.exports = {
  create: function(config, next) {
    new Vhost(config).init(next);
  },
};

inherits(Vhost, EventEmitter);

function Vhost(config) {

  var self = this;
  var connection;
  var connectionConfig;
  var channelPool;
  var confirmChannelPool;
  var channelCreator = async.queue(createChannel, 1);

  var init = async.compose(tasks.closeChannel, tasks.applyBindings, tasks.purgeQueues, tasks.checkQueues, tasks.assertQueues, tasks.checkExchanges, tasks.assertExchanges, tasks.createChannel, tasks.createConnection, tasks.checkVhost, tasks.assertVhost);
  var connect = async.compose(tasks.createConnection);
  var purge = async.compose(tasks.closeConnection, tasks.closeChannel, tasks.purgeQueues, tasks.createChannel, tasks.createConnection);
  var nuke = async.compose(tasks.closeConnection, tasks.closeChannel, tasks.deleteQueues, tasks.deleteExchanges, tasks.createChannel, tasks.createConnection);
  var timer = backoff({});

  this.name = config.name;
  this.connectionIndex = 0;

  pauseChannelAllocation();

  this.init = function(next) {
    debug('Initialising vhost: %s', self.name);
    pauseChannelAllocation();

    init(config, { connectionIndex: self.connectionIndex }, function(err, config, ctx) {
      if (err) return next(err);
      self.emit('connect');

      attachErrorHandlers(ctx.connection, config);

      forwardEvents(ctx.connection, self, function(eventName) {
        return eventName === 'blocked' || eventName === 'unblocked';
      });
      debug('vhost: %s was initialised with connection: %s', self.name, ctx.connection._rascal_id);
      connection = ctx.connection;
      self.connectionIndex = ctx.connectionIndex;
      connectionConfig = ctx.connectionConfig;
      timer = backoff(ctx.connectionConfig.retry);

      createChannelPools();
      resumeChannelAllocation();

      return next(null, self);
    });
    return self;
  };

  this.shutdown = function(next) {
    debug('Shuting down vhost: %s', self.name);
    pauseChannelAllocation();
    drainChannelPools(function(err) {
      if (err) return next(err);
      self.disconnect(next);
    });
  };

  this.nuke = function(next) {
    debug('Nuking vhost: %s', self.name);
    pauseChannelAllocation();
    drainChannelPools(function(err) {
      if (err) return next(err);
      nuke(config, { connectionIndex: self.connectionIndex }, function(err, config, ctx) {
        if (err) return next(err);
        connection = undefined;
        debug('Finished nuking vhost: %s', self.name);
        setImmediate(next);
      });
    });
  };

  this.purge = function(next) {
    debug('Purging vhost: %s', self.name);
    purge(config, { purge: true, connectionIndex: self.connectionIndex }, function(err, config, ctx) {
      if (err) return next(err);
      debug('Finished purging vhost: %s', self.name);
      setImmediate(next);
    });
  };

  this.bounce = function(next) {
    async.series([
      self.disconnect,
      self.init,
    ], next);
  };

  this.connect = function(next) {
    debug('Connecting to vhost: %s', self.name);
    connect(config, { connectionIndex: self.connectionIndex }, function(err, config, ctx) {
      return next(err, ctx.connection);
    });
  };

  this.disconnect = function(next) {
    debug('Disconnecting from vhost: %s', self.name);
    if (!connection) return next();
    connection.removeAllListeners();
    connection.on('error', function(err) {
      debug('Error disconnecting from %s. Original error was: %s', connectionConfig.loggableUrl, err.message);
    });
    connection.close(next);
  };

  this.getChannel = function(next) {
    channelCreator.push({ confirm: false }, next);
    debug('Requested channel. Outstanding channel requests: %d', channelCreator.length());
  };

  this.getConfirmChannel = function(next) {
    channelCreator.push({ confirm: true }, next);
    debug('Requested confirm channel. Outstanding channel requests: %d', channelCreator.length());
  };

  this.borrowChannel = function(next) {
    if (!channelPool) return next(new Error(format('VHost: %s must be initialised before you can borrow a channel', self.name)));
    channelPool.borrow(next);
  };

  this.returnChannel = function(channel) {
    if (!channelPool) return;
    channelPool.return(channel);
  };

  this.borrowConfirmChannel = function(next) {
    if (!channelPool) return next(new Error(format('VHost: %s must be initialised before you can borrow a confirm channel', self.name)));
    confirmChannelPool.borrow(next);
  };

  this.returnConfirmChannel = function(channel) {
    if (!confirmChannelPool) return;
    confirmChannelPool.return(channel);
  };

  function createChannelPool(options) {
    var pool, poolQueue;
    var mode = getChannelMode(options.confirm);
    var busy = false;

    var factory = {
      create: function() {
        return new Promise(function(resolve, reject) {
          createChannel(options.confirm, function(err, channel) {
            if (err) return reject(err);
            var destroyChannel = _.once(function() {
              channel._rascal_closed = true;
              if (pool.isBorrowedResource(channel)) {
                pool.destroy(channel).catch(function(err) {
                  debug('Error destroying %s channel: %s. %s', mode, err.message);
                });
              }
            });
            channel.once('error', destroyChannel);
            channel.once('close', destroyChannel);
            resolve(channel);
          });
        });
      },
      destroy: function(channel) {
        return new Promise(function(resolve) {
          debug('Destroying channel: %s', channel._rascal_id);
          if (!channel._rascal_closed) channel.close();
          resolve();
        });
      },
      validate: function(channel) {
        return new Promise(function(resolve) {
          resolve(!channel._rascal_closed && connection && connection.connection === channel.connection);
        });
      },
    };

    function stats() {
      return {
        vhost: self.name,
        mode: mode,
        queue: poolQueue.length(),
        size: pool.size,
        available: pool.available,
        borrowed: pool.borrowed,
        min: pool.min,
        max: pool.max,
      };
    }

    function borrow(next) {
      debug('Requested %s channel. %o', mode, stats());
      if (poolQueue.length() >= options.pool.max) {
        busy = true;
        self.emit('busy', stats());
      }
      poolQueue.push(null, function (err, channel) {
        if (err) return next(err);
        debug('Borrowed %s channel: %s. %o', mode, channel._rascal_id, stats());
        next(null, channel);
      });
    }

    function release(channel) {
      debug('Releasing %s channel: %s. %o', mode, channel._rascal_id, stats());
      pool.release(channel).then(function() {
        if (poolQueue.length() > 0 || !busy) return;
        busy = false;
        self.emit('ready', stats());
      }).catch(function(err) {
        debug('Error releasing %s channel: %s. %s', mode, err.message);
      });
    }

    function drain(next) {
      debug('Draining %s channel pool. %o', mode, stats());
      pool.drain().then(function() {
        return pool.clear().then(function() {
          debug('Drained %s channel pool. %o', mode, stats());
          setImmediate(next);
        });
      }).catch(function(err) {
        debug('Error draining %s channel pool. %s', mode, err.message);
        setImmediate(next);
      });
    }

    debug('Creating %s channel pool %o', mode, options.pool);
    pool = genericPool.createPool(factory, options.pool);

    poolQueue = async.queue(function(__, next) {
      pool.acquire().then(function(channel) {
        setImmediate(function() {
          next(null, channel);
        });
      }).catch(next);
    }, 1);

    return {
      stats: stats,
      borrow: borrow,
      return: release,
      drain: drain,
      pause: poolQueue.pause.bind(poolQueue),
      resume: poolQueue.resume.bind(poolQueue),
    };
  }

  function createChannel(confirm, next) {

    // Same problem as https://github.com/guidesmiths/rascal/issues/17
    var once = _.once(next);
    var invocations = 0;
    var channelId = uuid();

    confirm ? connection.createConfirmChannel(callback) : connection.createChannel(callback);

    function callback(err, channel) {
      invocations++;
      if (err) {
        debug('Error creating channel: %s from %s: %s', channelId, connectionConfig.loggableUrl, err.message);
        return once(err);
      }

      channel._rascal_id = channelId;
      channel.connection._rascal_id = connection._rascal_id;
      channel.connection.setMaxListeners(0);
      debug('Created %s channel: %s from connection: %s', getChannelMode(confirm), channel._rascal_id, connection._rascal_id);

      // See https://github.com/squaremo/amqp.node/issues/388
      if (invocations > 1) {
        debug('Closing superfluous channel: %s previously reported as errored', channel._rascal_id);
        return channel.close();
      }

      once(null, channel);
    }
  }

  function getChannelMode(confirm) {
    return confirm ? 'confirm' : 'regular';
  }

  function pauseChannelAllocation() {
    channelCreator.pause();
    channelPool && channelPool.pause();
    confirmChannelPool && confirmChannelPool.pause();
  }

  function resumeChannelAllocation() {
    channelCreator.resume();
    channelPool && channelPool.resume();
    confirmChannelPool && confirmChannelPool.resume();
  }

  function createChannelPools() {
    channelPool = createChannelPool({ confirm: false, pool: config.publicationChannelPools.regularPool });
    confirmChannelPool = createChannelPool({ confirm: true, pool: config.publicationChannelPools.confirmPool });
  }

  function drainChannelPools(next) {
    async.series([
      function(cb) {
        channelPool ? channelPool.drain(cb) : cb();
      },
      function(cb) {
        confirmChannelPool ? confirmChannelPool.drain(cb) : cb();
      },
    ], next);
  }

  function attachErrorHandlers(connection, config) {
    connection.removeAllListeners('error');
    var errorHandler = _.once(handleConnectionError.bind(null, connection, config));
    connection.once('error', errorHandler);
    connection.once('close', errorHandler);
  }

  function handleConnectionError(borked, config, err) {
    debug('Handling connection error: %s initially from connection: %s, vhost:%s', err.message, borked._rascal_id, connectionConfig.loggableUrl);
    self.emit('disconnect');
    pauseChannelAllocation();
    connection = undefined;
    self.emit('error', err);
    connectionConfig.retry && self.init(function(err) {
      if (!err) return;
      var delay = timer.next();
      debug('Will attempt reconnection in in %dms', delay);
      return setTimeout(handleConnectionError.bind(null, borked, config, err), delay).unref();
    });
  }
}
