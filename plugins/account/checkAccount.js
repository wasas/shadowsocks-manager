const log4js = require('log4js');
const logger = log4js.getLogger('account');
const knex = appRequire('init/knex').knex;
const serverManager = appRequire('plugins/flowSaver/server');
const flow = appRequire('plugins/flowSaver/flow');
const manager = appRequire('services/manager');
const moment = require('moment');
const cron = appRequire('init/cron');
let messages = [];

const sendMessage = () => {
  if(!messages.length) {
    return;
  }
  messages.forEach(message => {
    manager.send(message[0], message[1]).then().catch();
  });
  messages = [];
};

cron.second(() => {
  sendMessage();
}, 10);

const addPort = (data, server) => {
  messages.push([{
    command: 'add',
    port: data.port,
    password: data.password,
  }, {
    host: server.host,
    port: server.port,
    password: server.password,
  }]);
};

const delPort = (data, server) => {
  messages.push([{
    command: 'del',
    port: data.port,
  }, {
    host: server.host,
    port: server.port,
    password: server.password,
  }]);
};

const changePassword = async (id, password) => {
  const server = await serverManager.list();
  const account = await knex('account_plugin').select();
  const port = account.filter(f => f.id === id)[0].port;
  if(!port) { return Promise.reject('account id not exists'); }
  server.forEach(s => {
    messages.push([{
      command: 'pwd',
      port,
      password,
    }, {
      host: s.host,
      port: s.port,
      password: s.password,
    }]);
  });
  return;
};

const checkFlow = async (server, port, startTime, endTime) => {
  let isMultiServerFlow = false;
  try {
    isMultiServerFlow = await knex('webguiSetting').select().
    where({ key: 'system' })
    .then(success => {
      if(!success.length) {
        return Promise.reject('settings not found');
      }
      success[0].value = JSON.parse(success[0].value);
      return success[0].value.multiServerFlow;
    });
  } catch (err) {}
  const serverId = isMultiServerFlow ? null : server;
  const userFlow = await flow.getFlowFromSplitTime(serverId, port, startTime, endTime);
  return userFlow;
};

const checkFlowTime = {};

const checkServer = async () => {
  logger.info('check account');
  const account = await knex('account_plugin').select();
  account.forEach(a => {
    if(a.type >= 2 && a.type <= 5) {
      let timePeriod = 0;
      if(a.type === 2) { timePeriod = 7 * 86400 * 1000; }
      if(a.type === 3) { timePeriod = 30 * 86400 * 1000; }
      if(a.type === 4) { timePeriod = 1 * 86400 * 1000; }
      if(a.type === 5) { timePeriod = 3600 * 1000; }
      const data = JSON.parse(a.data);
      let startTime = data.create;
      while(startTime + timePeriod <= Date.now()) {
        startTime += timePeriod;
      }
      if(data.create + data.limit * timePeriod <= Date.now() || data.create >= Date.now()) {
        if(a.autoRemove) {
          knex('account_plugin').delete().where({ id: a.id }).then();
        }
      }
    }
  });
  const server = await serverManager.list();
  account.exist = number => {
    return !!account.filter(f => f.port === number)[0];
  };
  let isMultiServerFlow = false;
  try {
    isMultiServerFlow = await knex('webguiSetting').select().
    where({ key: 'system' })
    .then(success => {
      if(!success.length) {
        return Promise.reject('settings not found');
      }
      success[0].value = JSON.parse(success[0].value);
      return success[0].value.multiServerFlow;
    });
  } catch (err) {}
  const promises = [];
  server.forEach(s => {
    const checkServerAccount = async s => {
      try {
        const port = await manager.send({ command: 'list' }, {
          host: s.host,
          port: s.port,
          password: s.password,
        });
        port.exist = number => {
          return !!port.filter(f => f.port === number)[0];
        };
        const checkAccountStatus = async a => {
          const accountServer = a.server ? JSON.parse(a.server) : a.server;
          if(accountServer) {
            newAccountServer = accountServer.filter(f => {
              return server.filter(sf => sf.id === f)[0];
            });
            if(JSON.stringify(newAccountServer) !== JSON.stringify(accountServer)) {
              await knex('account_plugin').update({
                server: JSON.stringify(newAccountServer),
              }).where({
                port: a.port,
              });
            }
          }
          if(accountServer && accountServer.indexOf(s.id) < 0) {
            port.exist(a.port) && delPort(a, s);
            return;
          }
          if(a.type >= 2 && a.type <= 5) {
            let timePeriod = 0;
            if(a.type === 2) { timePeriod = 7 * 86400 * 1000; }
            if(a.type === 3) { timePeriod = 30 * 86400 * 1000; }
            if(a.type === 4) { timePeriod = 1 * 86400 * 1000; }
            if(a.type === 5) { timePeriod = 3600 * 1000; }
            const data = JSON.parse(a.data);
            let startTime = data.create;
            while(startTime + timePeriod <= Date.now()) {
              startTime += timePeriod;
            }
            let flow = 0;
            if(!checkFlowTime['' + s.id + a.port] || (checkFlowTime['' + s.id + a.port] && Date.now() >= checkFlowTime['' + s.id + a.port])) {
              flow = await checkFlow(s.id, a.port, startTime, Date.now());
              const nextTime = (data.flow * (isMultiServerFlow ? 1 : s.scale) - flow) / 200000000 * 60 * 1000;
              if(nextTime <= 0) {
                checkFlowTime['' + s.id + a.port] = Date.now() + 5 * 60 * 1000;
              } else {
                checkFlowTime['' + s.id + a.port] = Date.now() + nextTime;
              }
            }
            if(isMultiServerFlow && flow >= data.flow) {
              port.exist(a.port) && delPort(a, s);
              return;
            } else if (!isMultiServerFlow && flow >= data.flow * s.scale) {
              port.exist(a.port) && delPort(a, s);
              return;
            } else if(data.create + data.limit * timePeriod <= Date.now() || data.create >= Date.now()) {
              port.exist(a.port) && delPort(a, s);
              return;
            } else if(!port.exist(a.port) && flow) {
              addPort(a, s);
              return;
            }
          } else if (a.type === 1) {
            if(port.exist(a.port)) {
              return;
            }
            addPort(a, s);
            return;
          }
        };
        const checkAccountStatusPromises = [];
        account.forEach(a => {
          checkAccountStatusPromises.push(checkAccountStatus(a));
        });
        Promise.all(checkAccountStatusPromises);
        port.forEach(async p => {
          if(!account.exist(p.port)) {
            delPort(p, s);
            return;
          }
        });
      } catch (err) {
        logger.error(err);
        return;
      }
    };
    promises.push(checkServerAccount(s));
  });
  Promise.all(promises);
  // promises.forEach((p, index) => {
  //   setTimeout(() => {
  //     p.then();
  //   }, 5 * 60 * 1000 / promises.length * index);
  // });
};

exports.checkServer = checkServer;
exports.sendMessage = sendMessage;
exports.addPort = addPort;
exports.delPort = delPort;
exports.changePassword = changePassword;

setTimeout(() => {
  checkServer();
}, 8 * 1000);
cron.minute(() => {
  checkServer();
}, 2);
