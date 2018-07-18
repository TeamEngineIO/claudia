/*global describe, it, expect, beforeEach, afterEach */
const underTest = require('../src/commands/add-sqs-event-source'),
	create = require('../src/commands/create'),
	destroyObjects = require('./util/destroy-objects'),
	tmppath = require('../src/util/tmppath'),
	fsUtil = require('../src/util/fs-util'),
	retry = require('oh-no-i-insist'),
	fs = require('fs'),
	path = require('path'),
	aws = require('aws-sdk'),
	awsRegion = require('./util/test-aws-region');
describe('addSQSEventSource', () => {
	'use strict';
	let workingdir, testRunName, newObjects, config, logs, lambda, sqs;
	beforeEach(() => {
		workingdir = tmppath();
		logs = new aws.CloudWatchLogs({ region: awsRegion });
		lambda = new aws.Lambda({ region: awsRegion });
		testRunName = 'test' + Date.now();
		newObjects = { workingdir: workingdir };
		fs.mkdirSync(workingdir);
		config = {
			queue: testRunName,
			source: workingdir,
			'batch-size': 1
		};
		sqs = new aws.SQS({region: awsRegion});
	});
	afterEach(done => {
		destroyObjects(newObjects).then(done, done.fail);
	});
	describe('validation', () => {
		it('fails when the queue is not defined in options', done => {
			config.queue = '';
			underTest(config)
				.then(done.fail, reason => {
					expect(reason).toEqual('SQS queue not specified. please provide it with --queue');
					done();
				});
		});
		it('fails when the source dir does not contain the project config file', done => {
			underTest(config).then(done.fail, reason => {
				expect(reason).toEqual('claudia.json does not exist in the source folder');
				done();
			});
		});
		it('fails when the project config file does not contain the lambda name', done => {
			fs.writeFileSync(path.join(workingdir, 'claudia.json'), '{}', 'utf8');
			underTest(config)
				.then(done.fail, reason => {
					expect(reason).toEqual('invalid configuration -- lambda.name missing from claudia.json');
					done();
				});
		});
		it('fails when the project config file does not contain the lambda region', done => {
			fs.writeFileSync(path.join(workingdir, 'claudia.json'), JSON.stringify({ lambda: { name: 'xxx' } }), 'utf8');
			underTest(config)
				.then(done.fail, reason => {
					expect(reason).toEqual('invalid configuration -- lambda.region missing from claudia.json');
					done();
				});
		});
	});
	describe('when params are valid', () => {
		let createConfig,  queueUrl, queueArn;
		beforeEach((done) => {
			sqs.createQueue({
				QueueName: testRunName
			}).promise()
			.then(result => {
				queueUrl = result.QueueUrl;
				newObjects.sqsQueueUrl = queueUrl;
			})
			.then(() => sqs.getQueueAttributes({
				QueueUrl: queueUrl,
				AttributeNames: ['QueueArn']
			}).promise())
			.then(result => {
				queueArn = result.Attributes.QueueArn;
			})
			.then(done, done.fail);
		});
		const createLambda = function () {
				return create(createConfig)
					.then(result => {
						newObjects.lambdaRole = result.lambda && result.lambda.role;
						newObjects.lambdaFunction = result.lambda && result.lambda.name;
					});
			},
			sendMessage = function (info) {
				return sqs.sendMessage({
					QueueUrl: queueUrl,
					MessageBody: info || 'abcd'
				}).promise();
			};
		beforeEach(() => {
			createConfig = { name: testRunName, region: awsRegion, source: workingdir, handler: 'main.handler' };
			fsUtil.copy('spec/test-projects/hello-world', workingdir, true);
		});
		it('sets up privileges if role is given with name', done => {
			createLambda()
			.then(() => underTest(config))
			.then(() => lambda.listEventSourceMappings({FunctionName: testRunName}).promise())
			.then(config => {
				expect(config.EventSourceMappings.length).toBe(1);
				expect(config.EventSourceMappings[0].FunctionArn).toMatch(new RegExp(testRunName + '$'));
				expect(config.EventSourceMappings[0].EventSourceArn).toEqual(queueArn);
			})
			.then(done, done.fail);
		});
		it('sets up queue using an ARN', done => {
			config.queue = queueArn;
			createLambda()
			.then(() => underTest(config))
			.then(() => lambda.listEventSourceMappings({FunctionName: testRunName}).promise())
			.then(config => {
				expect(config.EventSourceMappings[0].EventSourceArn).toEqual(queueArn);
			})
			.then(done, done.fail);
		});
		it('invokes lambda from SQS when no version is given', done => {
			createLambda()
			.then(() => underTest(config))
			.then(() => sendMessage(testRunName))
			.then(() => {
				return retry(() => {
					console.log(`trying to get events from /aws/lambda/${testRunName}`);
					return logs.filterLogEvents({ logGroupName: '/aws/lambda/' + testRunName, filterPattern: 'sqs' })
						.promise()
						.then(logEvents => {
							if (logEvents.events.length) {
								return logEvents.events;
							} else {
								return Promise.reject();
							}
						});
				}, 30000, 10, undefined, undefined, Promise);
			})
			.then(done, done.fail);
		});
		it('binds to an alias, if the version is provided', done => {
			createConfig.version = 'special';
			config.version = 'special';
			createLambda()
			.then(() => underTest(config))
			.then(() => lambda.listEventSourceMappings({FunctionName: `${testRunName}:special`}).promise())
			.then(config => {
				expect(config.EventSourceMappings.length).toBe(1);
				expect(config.EventSourceMappings[0].FunctionArn).toMatch(new RegExp(testRunName + ':special$'));
				expect(config.EventSourceMappings[0].EventSourceArn).toEqual(queueArn);
			})
			.then(done, done.fail);
		});
		it('sets up batch size', done => {
			config['batch-size'] = 5;
			createLambda()
			.then(() => underTest(config))
			.then(() => lambda.listEventSourceMappings({FunctionName: testRunName}).promise())
			.then(config => {
				expect(config.EventSourceMappings.length).toBe(1);
				expect(config.EventSourceMappings[0].BatchSize).toEqual(5);
			})
			.then(done, done.fail);
		});

		it('invokes lambda from SQS when version is provided', done => {
			createConfig.version = 'special';
			config.version = 'special';
			createLambda()
			.then(() => underTest(config))
			.then(() => sendMessage(testRunName))
			.then(() => {
				return retry(() => {
					console.log(`trying to get events from /aws/lambda/${testRunName}`);
					return logs.filterLogEvents({ logGroupName: '/aws/lambda/' + testRunName, filterPattern: 'sqs' })
						.promise()
						.then(logEvents => {
							if (logEvents.events.length) {
								return logEvents.events;
							} else {
								return Promise.reject();
							}
						});
				}, 30000, 10, undefined, undefined, Promise);
			})
			.then(done, done.fail);
		});
	});
});
