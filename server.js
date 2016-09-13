var express = require('express');
var path = require('path');
var cors = require('cors');
var http = require('http');
var bodyParser = require('body-parser');
var rp = require('request-promise');

var dbRequest = require('./db/dbRequestHandler.js');

var app = express();

app.use(cors());

// This initializes the connections to our APIs' web sockets
dbRequest.initializeSockets();

// This initializes the GET requests we will be using
// to fetch data from APIs without web sockets
dbRequest.initializeGetRequests();

// This specifies the interval for which we will aggregate
// our API market data tables into our aggregated market
// data table
setInterval(function() {
  dbRequest.aggregateTables();
}, 60000);

// Sending a GET request to /api/marketdata will return
// an answer from our aggregated market data table,
// based on user-specified parameters
app.get('/api/marketdata', function(req, res) {
  console.log('Interpreting market data request.');
  dbRequest.deliverMarketData(req).then(function(data) {
    res.status(200).send(data);
  });
});

app.post('/api/getcoins', bodyParser.json(), function(req, res) {
	if (req.body.address) {
		var token = require('./secrets').blockcypherToken;
		rp({
			method: "POST",
			url: "https://api.blockcypher.com/v1/btc/test3/faucet?token=" + token,
			body: {
				address: req.body.address,
				amount: 490000
			},
			json: true
		}).then(function(response) {
			res.send(response)
		}).catch(function(err) {
			if (err.error) {
				res.send(err.error);
			} else {
				res.send({error: "Get testnet coins failed"});
			}
		});
	} else {
		res.send({error: "No address provided"});
	}

})

var port = process.env.PORT || 3010;

app.listen(port, function() {
	console.log("Listening on: ", port);
});
