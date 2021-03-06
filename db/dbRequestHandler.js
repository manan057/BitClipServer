var q = require('q');
var http = require('http');
var https = require('https');
var Pusher = require('pusher-client');
var db = require('./dbSchema.js');
var BitstampData = require('./models/bitstampModel.js');
var BitfinexData = require('./models/bitfinexModel.js');
var IndependentReserveData = require('./models/independentReserveModel.js');
var generate = require('nanoid/generate');

// List of all API sockets we want to connect to
var apiSockets = {
  bitstamp: ['de504dc5763aeef9ff52', 'live_trades']
};

// List of all API URLs we will send GET requests to
// Format: [URL, requests/hour]
var apiGetRequests = {
  bitfinex: ['https://api.bitfinex.com/v1/trades/btcusd?timestamp=', 60],
  independentReserve: ['https://api.independentreserve.com/Public/GetRecentTrades?primaryCurrencyCode=xbt&secondaryCurrencyCode=usd&numberOfRecentTradesToRetrieve=50', 60]
};

// Format: [APIModelName, APITableName]
var apiDbSetup = {
  bitstamp: [BitstampData, 'bitstampMarketData'],
  bitfinex: [BitfinexData, 'bitfinexMarketData'],
  independentReserve: [IndependentReserveData, 'independentReserveMarketData']
};

// The obj is the JSON object we receive from the API.
// Map it to the keys provided
var apiModelInfo = {
  bitstamp: function(obj) {
    return {
      bitstampTradeKey: obj.id,
      amount: obj.amount,
      price: obj.price
    };
  },
  bitfinex: function(obj) {
    return {
      bitfinexTradeKey: obj.tid,
      amount: obj.amount,
      price: obj.price,
      createdAt: obj.timestamp * 1000
    };
  },
  independentReserve: function(obj) {
    return {
      independentReserveTradeKey: generate('0123456789', 8),
      amount: obj.PrimaryCurrencyAmount,
      price: obj.SecondaryCurrencyTradePrice,
      createdAt: new Date(obj.TradeTimestampUtc).getTime()
    };
  }
};

// The row is the row of data from the API market data table
// that will be added to our aggregated market data table
var apiTableInfo = {
  bitstamp: function(row) {
    return {
      sourceKey: row.sourceKey,
      amount: row.amount,
      price: row.price,
      createdAt: row.createdAt
    };
  },
  bitfinex: function(row) {
    return {
      sourceKey: row.sourceKey,
      amount: row.amount,
      price: row.price,
      createdAt: row.createdAt
    };
  },
  independentReserve: function(row) {
    return {
      sourceKey: row.sourceKey,
      amount: row.amount,
      price: row.price,
      createdAt: row.createdAt
    };
  }
};

var dbRequests = {};

/************************************************************
Market data requests
************************************************************/

// Finds all APIs configured to use a socket in our
// apiSockets table and initializes their sockets
dbRequests.initializeSockets = function() {
  for (var api in apiSockets) {
    var pusher = new Pusher(apiSockets[api][0]);
    var tradeDataChannel = pusher.subscribe(apiSockets[api][1]);

    tradeDataChannel.bind('trade', function(tradeData) {
      dbRequests.createModels(api, tradeData);
    });
  }
};

dbRequests.initializeGetRequests = function() {
  var httpsCheck = new RegExp('https://');
  var httpCheck = new RegExp('http://');

  for (var api in apiGetRequests) {
    if (httpsCheck.exec(apiGetRequests[api][0])) {
      if (api === 'bitfinex') {
        dbRequests.getRequestEvents[api] = function() {
          var url = apiGetRequests.bitfinex[0] + (Math.ceil((Date.now() / 1000)) - 59);
          https.get(url, function(res) {
            var data = '';
            res.on('data', function(chunk) {
              data += chunk;
            });
            res.on('end', function() {
              data = JSON.parse(data);
              for (var i = 0, l = data.length; i < l; i++) {
                dbRequests.createModels('bitfinex', data[i]);
              }
            });
          });
        };
      } else if (api === 'independentReserve') {
        dbRequests.getRequestEvents[api] = function() {
          var timeThreshold = Math.ceil(Date.now() / 1000) - 49;
          var url = apiGetRequests.independentReserve[0];
          https.get(url, function(res) {
            var data = '';
            res.on('data', function(chunk) {
              data += chunk;
            });
            res.on('end', function() {
              data = JSON.parse(data);
              for (var i = 0, l = data.Trades.length; i < l; i++) {
                dbRequests.createModels('independentReserve', data.Trades[i]);
              }
            });
          });
        };
      }
    } else if (httpCheck.exec(apiGetRequests[api][0])) {
      // No http:// GET requests for now
    }
    setInterval(dbRequests.getRequestEvents[api], 3600000 / apiGetRequests[api][1]);
  }
};

dbRequests.getRequestEvents = {};

dbRequests.createModels = function(api, obj) {
  var trade = new apiDbSetup[api][0](apiModelInfo[api](obj));

  trade.save().then(function(tradeModel) {
    tradeModel.destroy();
  });
};

// First, this function checks our sources table to
// see if the API has already been added; if not,
// it will be added. Then, insertDataIntoAggregateTable
// will be executed
dbRequests.aggregateTables = function() {
  Object.keys(apiDbSetup).forEach(function(api) {
    db.knex('sources').where({source: api})
      .select()
      .then(function(rows) {
        if (!rows.length) {
          db.knex('sources').insert({source: api})
            .then(function() {
              dbRequests.insertDataIntoAggregateTable(api);
            });
        } else {
          dbRequests.insertDataIntoAggregateTable(api);
        }
      });
  });
};

// Truncates the API market data table and inserts its
// data into the aggregate market data table
dbRequests.insertDataIntoAggregateTable = function(api) {
  db.knex.raw('SELECT b.sourceKey, a.amount, a.price, a.createdAt FROM ' + apiDbSetup[api][1] + ' a INNER JOIN sources b ON "' + api + '" = b.source')
    .then(function(rows) {
      db.knex.raw('DELETE FROM ' + apiDbSetup[api][1] + '; VACUUM')
        .then(function() {
          rows.forEach(function(row) {
            db.knex('aggregatedMarketData').insert(apiTableInfo[api](row))
              .then(function() {});
          });
        });
    });
};

dbRequests.deliverMarketData = function(req) {
  var deferred = q.defer();
  var time = parseInt(req.query.time);
  var timePeriod = parseInt(req.query.timePeriod);

  db.knex.raw('SELECT source, MAX(createdAt) AS createdAt, (SUM(amount * price) / SUM(amount)) AS volumeWeightedAvgPrice FROM aggregatedMarketData a INNER JOIN sources b ON a.sourceKey = b.sourceKey WHERE createdAt BETWEEN "' + (time - timePeriod) + '" AND "' + time + '" GROUP BY a.sourceKey, ROUND(createdAt / 900000)')
    .then(function(rows) {
      var exchanges = {};
      var transactions = [];

      for (var i = 0, l = rows.length; i < l; i++) {
        if (!exchanges.hasOwnProperty(rows[i].source)) {
          exchanges[rows[i].source] = [[rows[i].createdAt, rows[i].volumeWeightedAvgPrice]];
        } else {
          exchanges[rows[i].source].push([rows[i].createdAt, rows[i].volumeWeightedAvgPrice]);
        }
      }

      for (var key in exchanges) {
        transactions.push({key: key, values: exchanges[key]});
      }

      db.knex.raw('SELECT AVG(price) AS avgPrice FROM aggregatedMarketData WHERE createdAt BETWEEN "' + (time - timePeriod) + '" AND "' + time + '"')
        .then(function(rows) {
          var avgPrice = rows[0].avgPrice;
          db.knex.raw('SELECT MAX(price) AS maxPrice, MIN(price) AS minPrice, SUM(amount) AS volume, (SUM(price * amount) / SUM(amount)) AS volumeWeightedAvgPrice, SUM((price - ' + avgPrice + ') * (price - ' + avgPrice + ')) AS stdDeviationNumerator, COUNT(price) AS stdDeviationDenominator FROM aggregatedMarketData WHERE createdAt BETWEEN "' + (time - timePeriod) + '" AND "' + time + '"')
          .then(function(rows) {
            var result = {
              timePeriod: timePeriod,
              time: new Date().getTime(),
              transactions: transactions,
              stdDeviation: Math.sqrt(rows[0].stdDeviationNumerator / rows[0].stdDeviationDenominator),
              vwap: rows[0].volumeWeightedAvgPrice,
              max: rows[0].maxPrice,
              min: rows[0].minPrice,
              volume: rows[0].volume
            };
            deferred.resolve(result);
          });
        });
    });
  return deferred.promise;
};

module.exports = dbRequests;
