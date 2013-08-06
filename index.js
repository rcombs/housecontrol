#! /usr/bin/env node

// TODO: This all sucks. Make it not.

"use strict";

var PLM = require("PLM"),
	util = PLM.util,
	CONSTANTS = PLM.CONSTANTS,
	fs = require("fs"),
	http = require("http"),
	express = require("express"),
	socketio = require("socket.io"),
	Reminder = require('reminder');

var config = JSON.parse(fs.readFileSync(process.argv[2] || __dirname + "/config.json"));
var groups = {};

for(var i in config.devices){
	var device = config.devices[i];
	if(!device.groups){
		device.groups = [];
	}
	if(device.address){
		device.address = util.parseHex(device.address);
	}
	for(var j = 0; j < device.groups.length; j++){
		if(!groups[device.groups[j]]){
			groups[device.groups[j]] = [];
		}
		groups[device.groups[j]].push(i);
	}
}

var groupArr = Object.keys(groups);
var deviceArr = Object.keys(config.devices);

var app = express();

// TODO: Write proper modem management
var modem = new PLM(config.modems.PLM.path);

var remind = new Reminder();

var server = http.createServer(app);

app.use(express.logger());

app.use(express.static(__dirname + "/static"));

app.use(express.bodyParser());

app.get("/", function(req, res, next){
	// TODO: Move this to an EJS view
	fs.readFile(__dirname + "/static/index.htm", function(err, data){
		if(err){
			return next(err);
		}
		var configJSON = JSON.stringify({
			groups: groups,
			devices: config.devices
		});
		res.send(data.toString("utf8").replace("%CONFIG%", configJSON));
	});
});

var pebbleDeviceTypes = {
	"dimmer": 0x0,
	"lock": 0x1,
	"relay": 0xF
}

app.post("/pebble", function(req, res, next){
	if(req.body["1"] !== config.users.PEBBLE.password){
		return next("Bad Auth");
	}
	console.log(JSON.stringify(req.body));
	if(req.body["2"] == 0){
		var out = {
			"1": ["B", groupArr.length]
		}
		var buf = new Buffer(32);
		var i = req.body["3"];
		if(i < groupArr.length){
			buf.writeUInt8(i, 0);
			var bytes = buf.write(groupArr[i], 1, 30, "utf8");
			buf[1 + bytes] = 0x00;
		}
		out["2"] = ["d", buf.toString("base64")];
		console.log(JSON.stringify(out))
		return res.send(out);
	}else if(req.body["2"] == 1){
		var group = groups[groupArr[req.body["4"]]];
		if(!group){
			console.log(req.body);
			return res.send("FUCK");
		}
		var out = {
			"1": ["B", group.length]
		}
		var buf = new Buffer(34);
		var i = req.body["3"];
		console.log(i);
		if(i < group.length){
			buf.writeUInt8(deviceArr.indexOf(group[i]), 0);
			var bytes = buf.write(group[i], 1, 30, "utf8");
			buf[1 + bytes] = 0x00;
			var device = config.devices[group[i]];
			var type = pebbleDeviceTypes[device.type];
			if(type === undefined){
				type = 0xF;
			}
			buf.writeUInt16LE(type, 32);
		}
		out["2"] = ["d", buf.toString("base64")];
		return res.send(out);
	}else if(req.body["2"] == 3){
		modem.sendINSTEON({
			to: config.devices[deviceArr[req.body["3"]]].address,
			command: [req.body["4"], req.body["5"]]
		});
		res.send({});
	}
});

app.use(app.router);

app.use(function(err, req, res, next){
	console.log(err);
	next(err);
});

app.use(function(err, req, res, next){
	res.send(err);
});

server.listen(8999);

var io = socketio.listen(server);
io.set("authorization", function(handshakeData, callback){
	// TODO: Write real auth engine
	if(handshakeData.address.address.indexOf("192.168.1.") == 0){
		callback(null, true);
	}
});
modem.on("raw", function(msg){
//	console.log(msg.toString("hex"));
});
io.sockets.on("connection", function(socket){
	socket.on("sendCommand", function(data){
		modem.sendCommand(data, function(err, data){
			if(err){
				socket.emit("error", err.toString());
			}
			if(data && data.toString){
				socket.emit("log", "reply:" + data.toString("hex"));
			}
		});
	});
	socket.on("cancelLinking", function(){
		modem.cancelLinking(function(err){
			if(err){
				return socket.emit("error", err.toString());
			}
			socket.emit("canceledLinking");
		});
	});
	socket.on("link", function(mode, group){
		modem.linkINSTEONDevice(mode, group, function(err, data){
			if(err){
				return socket.emit("error", err.toString());
			}
			socket.emit("linked", data);
		});
	});
	socket.on("standardCommand", function(id, cmd){
		if(typeof id[0] == "number"){
			id = [id];
		}
		for(var i = 0; i < id.length; i++){
			modem.sendINSTEON({
				to: id[i],
				command: cmd
			}, function(err, message){
				if(err){
					socket.emit("error", err.toString());
				}
				if(message && message.command){
					socket.emit("commandReply", util.makeHex(message.command));
				}
			});
		}
	});
});
