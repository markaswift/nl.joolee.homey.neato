"use strict";

const Robot = require('./robot');
const neato = Homey.app.neato;

module.exports = new class {

	constructor() {
		// Define some internal variables
		this.devices = {};
		this.robots = {};

		// Map Homey interface functions (functions it expects to be in module.exports.XXX)
		this.init = this._init.bind(this);
		this.pair = this._pair.bind(this);
		this.added = this._device_added.bind(this);
		this.deleted = this._device_deleted.bind(this);
		// this.renamed = this._device_renamed.bind(this);
		this.settings = this._device_settings.bind(this);

		this.capabilities = {
			measure_battery: {
				get: this.ignore_capability_get.bind(this)
			},
			vacuumcleaner_state: {
				get: this.ignore_capability_get.bind(this),
				set: this.set_state.bind(this)
			}
		}
	}

	// Interface to Homey functions

	// AKA module.exports.init
	_init(devices, callback) {
		// Store the list of devices Homey gives us
		this.devices = devices;

		Homey.log('Devices:', devices);

		// Do authorisation stuff when needed
		neato.on('authorized', (authorized) => {
			if (authorized) {
				if (Object.keys(this.robots).length == 0) {
					this.initDevices();
				} else {
					Homey.log('Devices already initialized');
				}
			} else {
				this.deInitDevices();
			}
		});

		// Map flow functions
		// Action flows
		Homey.manager('flow').on('action.start_house_cleaning', this.action_start_house_cleaning.bind(this));
		Homey.manager('flow').on('action.stop_house_cleaning', this.action_stop_house_cleaning.bind(this));
		Homey.manager('flow').on('action.pause_house_cleaning', this.action_pause_house_cleaning.bind(this));
		Homey.manager('flow').on('action.resume_house_cleaning', this.action_resume_house_cleaning.bind(this));
		Homey.manager('flow').on('action.send_to_base', this.action_send_to_base.bind(this));
		Homey.manager('flow').on('action.start_spot_cleaning', this.action_start_spot_cleaning.bind(this));

		// Condition flows		
		Homey.manager('flow').on('condition.cleaning', this.condition_cleaning.bind(this));


		callback(null, true);
	}

	// AKA module.exports.pair
	_pair(socket) {
		socket.on('authorized', (data, callback) => {
			Homey.app.neato.isAuthorised()
				.then(() => callback(null, true))
				.catch(() => callback(null, false));
		});

		socket.on('authorize', (data, callback) => {
			Homey.app.neato.authorize(callback)
				.then((user) => {
					socket.emit('authorized', true, null);
				});
		});

		socket.on('list_devices', (data, callback) => {
			Homey.log('List devices started');
			// list_devices event is triggered multiple times when you leave the page open
			var foundDevices = [];

			Homey.app.neato.getRobots()
				.then((robots) => {
					robots.forEach((robot) => {
						Homey.log('Found robot:', robot);
						if (robot.model == 'BotVacConnected') {
							Homey.log('It\'s a Botvac connected!');
							foundDevices.push({
								name: robot.name,
								data: {
									id: robot.serial,
								},
								settings: robot
							});
						} else {
							Homey.log('Model is not supported by this driver');
						}

					});

					Homey.log('Found devices: ', foundDevices);

					callback(null, foundDevices);
				});
		});
	}

	// AKA module.exports.added
	_device_added(robot, callback) {
		console.log('Added device: ', robot);
		this.devices.push(robot);
		this.initRobot(robot);
	}

	// AKA module.exports.deleted
	_device_deleted(robot) {
		console.log('Removed device: ', robot);
		this.deInitRobot(robot);
		this.devices.splice(this.devices.indexOf(robot), 1);
		Homey.log('Devices left:', this.devices);
	}

	// AKA module.exports.settings
	_device_settings(robot, newSettingsObj, oldSettingsObj, changedKeysArr, callback) {
		// Don't do difficult stuff. Just re-create the robot
		console.log('Settings changed. Reinitialising device.', changedKeysArr);
		callback(null, true);
		this.initRobot(robot);
	}

	// End Interface to Homey functions /

	// Robot management functions

	initDevices() {
		if (Object.keys(this.devices).length > 0) {
			Homey.log('Initilise devices');
			this.devices.forEach(this.initRobot.bind(this));
		} else {
			Homey.log('No devices to initialise');
		}
	}

	deInitDevices() {
		if (Object.keys(this.devices).length > 0 && Object.keys(this.robots).length) {
			Homey.log('De-initialise all devices');
			this.devices.forEach(this.deInitRobot.bind(this));
		} else {
			Homey.log('No devices to de-initialize');
		}
	}

	deInitRobot(robot) {
		module.exports.setUnavailable(robot, "Robot not available at the moment");

		if (this.robots[robot.id]) {
			clearInterval(this.robots[robot.id].refreshInterval);
			Homey.log('Removing robot', robot);
			delete this.robots[robot.id];
		}
	}

	initRobot(robot) {
		// Start clean
		this.deInitRobot(robot);

		module.exports.getSettings(robot, (err, settings) => {
			Homey.log('Initialising robot', settings.name + ', current settings:');
			Homey.log(settings);

			this.robots[robot.id] = new Robot(settings.name, settings.serial, settings.secret_key);

			// Get robot state on initialise
			this.robots[robot.id].getState((error, robotStatus) => {
				if (!error && robotStatus.meta.modelName == 'BotVacConnected') {
					module.exports.setAvailable(robot);

					// Set up polling at regular intervals (randomize within 100ms to prevent all robots to poll at the same time)
					this.robots[robot.id].refreshInterval = setInterval(this.pollStatus.bind(this, robot),
						settings.polling_interval * 1000 + Math.floor(Math.random() * 100));

					this.robotStatusUpdate(robot, null, robotStatus);
					this.robots[robot.id].cachedStatus = robotStatus;
				} else if (error) {
					Homey.log("Encountered an error when fetching the robot's initial status. Retrying in " + settings.polling_interval + " seconds. Error:\n\r", error);
					this.deInitRobot(robot);
					// Retry later
					setTimeout(this.initRobot.bind(this, robot), settings.polling_interval * 1000);
					module.exports.setUnavailable(robot, error);
				} else {
					Homey.log('Cannot set robot available because model is unknown:', robotStatus.meta.modelName);
					this.deInitRobot(robot);
					module.exports.setUnavailable(robot, 'Model ' + robotStatus.meta.modelName + ' is unknown');
				}

			});
		});
	}

	pollStatus(robot) {
		Homey.log('Requesting state of robot:', this.robots[robot.id].name, 'from the Neato server');

		this.robots[robot.id].getState((error, robotStatus) => {
			if (this.robots[robot.id]) {
				this.robotStatusUpdate(robot, this.robots[robot.id].cachedStatus, robotStatus);
				this.robots[robot.id].cachedStatus = robotStatus;
			}
		})
	}

	// End robot management functions /

	// Device card (capability) functions
	ignore_capability_get(robot, callback) {
		// Apperantly, since version 1.0, capability GET functions are only called when the app has just been initialized.
		// We don't have the robot status at this moment so always return false
		// The device card is updated later with module.exports.realtime functions
		Homey.log("Ignoring capability 'get' function. This should only happen when the application or device is just initialised!");
		callback(null, false);
	}

	// Somebody changed the 'state' field in the device card 
	set_state(robot, command, callback) {
		if (typeof(this.robots[robot.id]) != 'undefined' && typeof(this.robots[robot.id].cachedStatus) == 'object') {

			var previousStatus = this._parse_state(this.robots[robot.id].cachedStatus);

			Homey.log('Set vacuum state to', command);
			if (command == 'cleaning') {
				this.action_start_house_cleaning((error, result) => {
					// Homey.log("Robot send house claning result:", error, result)
					if (result == 'failed') {
						Homey.log('Start house cleaning: failed, reverting to previous state!')
						module.exports.realtime(robot, 'vacuumcleaner_state', previousStatus);
					}
				}, {
					device: robot,
					cleaning_mode: 'false' // Default to turbo mode
				});
			} else if (command == 'spot_cleaning') {
				this.action_start_spot_cleaning((error, result) => {
					// Homey.log("Robot send spot cleaning result:", error, result)
					if (result == 'failed') {
						Homey.log('tart spot cleaning: failed, reverting to previous state!')
						module.exports.realtime(robot, 'vacuumcleaner_state', previousStatus);
					}
				}, {
					device: robot,
					cleaning_mode: 'false', // Default to turbo mode
					spot_width: 100, // Default to 100
					spot_height: 100, // Default to 100
					cleaning_frequency: 'true' // Default to 2 passes
				});
			} else if (command == 'stopped') {
				this.action_pause_house_cleaning((error, result) => {
					// Homey.log("Robot send pause result:", error, result)
					if (result == 'failed') {
						Homey.log('Pause cleaning: failed, reverting to previous state!')
						module.exports.realtime(robot, 'vacuumcleaner_state', previousStatus);
					}
				}, {
					device: robot
				});
			} else {
				// 'docked' and 'charging' and simply a safe default :)
				this.action_send_to_base((error, result) => {
					// Homey.log("Robot send to base result:", error, result)
					if (result == 'failed') {
						Homey.log('Send to base: failed, reverting to previous state!')
						module.exports.realtime(robot, 'vacuumcleaner_state', previousStatus);
					}
				}, {
					device: robot
				});
			}

			// Confirm to Homey that we set the command
			callback(null, command);
		} else {
			Homey.log("Vacuum state set but device not initialized yet");
			callback(null, false);
		}
	}

	// End device card (capability) functions /


	// Trigger card functions:

	// This function is run every time the Neato servers have been polled
	robotStatusUpdate(robot, cachedStatus, freshStatus) {
		//Homey.log("Robot status changed", robot, cachedStatus, freshStatus);

		if (cachedStatus == null || cachedStatus.state != freshStatus.state) {
			this.robotStateChanged(robot, cachedStatus, freshStatus);
		}

		if (cachedStatus == null || cachedStatus.details.isDocked != freshStatus.details.isDocked) {
			this.robotDockingChanged(robot, cachedStatus, freshStatus);
		}

		if (cachedStatus == null || cachedStatus.details.charge != freshStatus.details.charge) {
			this.robotChargeChanged(robot, cachedStatus, freshStatus);
		}
	}

	robotStateChanged(robot, cachedStatus, freshStatus) {
		var parsedState = this._parse_state(freshStatus);
		Homey.log('Activity status changed to: ' + parsedState + ' for robot ' + this.robots[robot.id].name);

		// Fire corresponding trigger card but not when the app has just initialized
		if (cachedStatus !== null) {
			var stateTriggers = ['state_stops_cleaning', 'state_starts_cleaning', 'state_paused', 'state_error'];
			this._triggerDevice(stateTriggers[freshStatus.state - 1], null, null, robot);
		}

		// Notify Homey for device card update
		// Also do this when the app has just been initialized
		module.exports.realtime(robot, 'vacuumcleaner_state', parsedState);
	}

	// Helper function to convert the Neato status object to something Homey will understand (stopped, cleaning, spot_cleaning, docked or charging)
	_parse_state(robotData) {
		var state = 'stopped';

		// state == busy
		Homey.log(robotData)
		if (robotData.state == 2) {
			if (robotData.action == 1) {
				state = 'cleaning';
			} else if (robotData.action == 2) {
				state = 'spot_cleaning';
			}
		}
		if (robotData.details.isDocked) {
			state = 'docked';
		}
		if (robotData.details.isCharging) {
			state = 'charging';
		}

		return state;
	}


	robotDockingChanged(robot, cachedStatus, freshStatus) {
		Homey.log('Dock status changed to: ' + freshStatus.details.isDocked + ' for robot ' + this.robots[robot.id].name);

		// Do not fire triggers when the app has just been initialized
		if (cachedStatus !== null) {
			if (freshStatus.details.isDocked) {
				this._triggerDevice('enters_dock', null, null, robot);

			} else {
				this._triggerDevice('leaves_dock', null, null, robot);
			}
		}
	}

	robotChargeChanged(robot, cachedStatus, freshStatus) {
		Homey.log('Charge status changed to: ' + freshStatus.details.charge + ' for robot ' + this.robots[robot.id].name);

		// Always inform Homey of a charge change, also when the device has just been initialized
		module.exports.realtime(robot, 'measure_battery', freshStatus.details.charge);
	}

	// End trigger card functions /

	// Condition card function

	condition_cleaning(callback, args) {
		var robot = this.robots[args.device.id];

		Homey.log("Condition card triggered: current state for robot" + robot.name + "is '" + robot.cachedStatus.state + "'");
		// Return true when state equels 2
		callback(null, (robot.cachedStatus.state == 2));
	}

	// End condition card function /

	// Action card functions

	action_start_house_cleaning(callback, args) {
		var robot = this.robots[args.device.id];
		Homey.log("Start house cleaning:", robot.name);

		robot.startCleaning(args.cleaning_mode == 'true', (error, result) => {
			Homey.log("Start house cleaning:", error, result)
			callback(null, error);
		});
	}

	action_stop_house_cleaning(callback, args) {
		var robot = this.robots[args.device.id];
		Homey.log("Stop cleaning:", robot.name);

		robot.stopCleaning((error, result) => {
			Homey.log("Stop cleaning:", error, result)
			callback(null, error);
		});
	}

	action_pause_house_cleaning(callback, args) {
		var robot = this.robots[args.device.id];
		Homey.log("Pause cleaning:", robot.name);

		robot.pauseCleaning((error, result) => {
			Homey.log("Pause cleaning:", error, result)
			callback(null, error);
		});
	}

	action_resume_house_cleaning(callback, args) {
		var robot = this.robots[args.device.id];
		Homey.log("Resume cleaning:", robot.name);

		robot.resumeCleaning((error, result) => {
			Homey.log("Resume cleaning:", error, result)
			callback(null, error);
		});
	}

	action_send_to_base(callback, args) {
		var robot = this.robots[args.device.id];
		Homey.log("Send to base:", robot.name);

		this.robots[args.device.id].sendToBase((error, result) => {
			Homey.log("Send to base:", error, result)
			callback(null, error);
		});
	}

	action_start_spot_cleaning(callback, args) {
		var robot = this.robots[args.device.id];
		Homey.log("Start spot cleaning:", robot.name, args);

		robot.startSpotCleaning(args.cleaning_mode == 'true', args.spot_width, args.spot_height, args.cleaning_frequency == 'true', (error, result) => {
			Homey.log("Start spot cleaning:", error, result)
			callback(null, error);
		});
	}

	// End action card functions



	// Helper function to add some debugging information
	_triggerDevice(eventName, tokens, state, device_data, callback) {
		console.log('Triggering flow card: \'' + eventName + '\' for robot ' + device_data.id);
		if (typeof callback !== 'function') {
			callback = (err, result) => {
				if (err) return Homey.error(err);
			}
		}

		Homey.manager('flow').triggerDevice(eventName, tokens, state, device_data, callback);
	}
}