var db = require('../dbSchema.js');

var IndependentReserveData = db.Model.extend({
  tableName: 'IndependentReserveMarketData',
  hasTimestamps: false        //depends on API
});

module.exports = IndependentReserveData;
