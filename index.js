const WebSocket = require('ws');
const fetch = require('node-fetch');
const fs = require('fs');
const ShareDB = require('@danielbuechele/sharedb/lib/client');
const {
  TOKEN_PATH,
  WEBHOOK_URL,
  WEBHOOK_CONTENT_FIELD,
  NUCLINO_APP_ID,
  NUCLINO_TEAM_ID,
  NUCLINO_TEAM,
} = require('./config.js');

const NOTIFICATION_DELAY = 60 * 1000;

function getHeaders(token) {
  return {
    Cookie: `_ga=GA1.2.2136818352.1517691405; _gid=GA1.2.1271612510.1517691405; app-uid=${NUCLINO_APP_ID}; tr_p7tlufngy5={"referrer":"","query":"","variant":"production"}; token=${token}`,
    Origin: 'https://app.nuclino.com',
  };
}

function createBrainBackup(token, brainId) {
  console.log('Create backup');
  fetch(
    `https://files.nuclino.com/export/brains/${brainId}.zip?format=md`,
    {
      method: 'GET',
      headers: getHeaders(token),
    }
  ).then(res => {
    console.log(`downloaded backup`);
    const fileStream = fs.createWriteStream('./backup.zip');
    res.body.pipe(fileStream);
  });
}

function updateToken() {
  const oldToken = fs
    .readFileSync(TOKEN_PATH)
    .toString()
    .trim();

  return fetch('https://api.nuclino.com/api/users/me/refresh-session', {
    method: 'POST',
    headers: {...getHeaders(oldToken), 'X-Requested-With': 'XMLHttpRequest'},
  })
    .then(res => res.headers.get('Set-Cookie'))
    .then(cookie => {
      const match = cookie.match(/token=([A-Za-z0-9+-\._]+)/);
      if (match && match.length > 0) {
        token = match[1];
        fs.writeFile(TOKEN_PATH, token, 'utf8');
      }
      return token;
    });
}

function subscribeTeam(connection) {
  const team = connection.get('ot_team', NUCLINO_TEAM_ID);

  team.subscribe();
  team.on('load', () => {
    console.log('team:', team.data);
    for (let member of team.data.members) {
      loadMemberData(connection, member.id);
    }
    cells.clear();
    console.log('##############');
    for (let brainId of team.data.brains) {
      subscribeBrain(connection, brainId)
    }
  });
}

const members = {};
function loadMemberData(connection, memberId) {
  const member = connection.get('ot_user', memberId);

  member.subscribe();
  member.on('load', () => {
    console.log('member:', member.data);
    members[memberId] = member.data;
  });
}

function subscribeBrain(connection, brainId) {
  const brain = connection.get('ot_brain', brainId);

  brain.subscribe();
  brain.on('load', () => {
    console.log('brain:', brain.data);
    traverseTree(connection, brain.data.mainCellId);
  });
}

function traverseTree(connection, id) {
  if (cells[id]) {
    return;
  }
  subscribeCell(connection, id, cell => {
    cell.data.childIds.map(id => traverseTree(connection, id));
  });
}

const cells = new Map();
function subscribeCell(connection, id, cb) {
  const cell = connection.get('ot_cell', id);
  cell.subscribe();
  console.log(`subscribed to cell ${id}`);
  cells[id] = cell;
  cell.on('op', (ops, source) => {
    console.log('op', cell.id, ops);
    scheduleNotification(cell, ops[0]);
  });
  if (typeof cb === 'function') {
    cell.on('load', () => cb(cell));
  }
}

const pending = {};
function scheduleNotification(cell, op) {
  const id = getTargetId(cell, op);
  let newCell = false;
  if (!cells[id]) {
    newCell = true;
    subscribeCell(cell.connection, id);
  }

  const summary = getSummary(cell, op);

  let update = {};
  if (pending[id]) {
    update = pending[id];
    update.summaries.push(summary);
    clearTimeout(update.timeout);
  } else {
    update.cellId = id;
    update.summaries = [summary];
    update.newCell = newCell;
  }

  update.timeout = setTimeout(() => {
    notify(update);
    clearTimeout(update.timeout);
    delete pending[id];
  }, NOTIFICATION_DELAY);
  pending[id] = update;
}

function getTargetId(cell, op) {
  const field = op.p[0];
  if (field === 'childIds' && op.li != null) {
    return op.li;
  }
  if (field === 'childIds' && op.ld != null) {
    return op.ld;
  }
  if (field === 'childIds' && op.lm != null) {
    return cell.data.childIds[op.lm];
  }
  return cell.id;
}

function getSummary(cell, op) {
  const field = op.p[0];
  if (field === 'childIds' && op.li != null) {
    const parent = getCellData(cell.id)
    return `Added to cluster \`${parent.name}\``;
  }
  if (field === 'childIds' && op.ld != null) {
    const parent = getCellData(cell.id)
    return `Removed from cluster \`${parent.name}\``;
  }
  if (field === 'childIds' && op.lm != null) {
    const from = op.p[1];
    const to = op.lm;
    const parent = getCellData(cell.id)
    return `Moved from position \`${from}\` to \`${to}\` in cluster \`${parent.name}\``;
  }
  if (field === 'memberIds' && op.li != null) {
    return `Added member ${getMemberData(op.li) || ''}`;
  }
  if (field === 'memberIds' && op.ld != null) {
    return `Removed member ${getMemberData(op.ld) || ''}`;
  }
  if (field === 'title') {
    return `Title changed`;
  }
  if (field === 'updatedAt') {
    return `Content changed`;
  }
  return `Changed \`${field}\``;
}

function notify(update) {
  const message = getUpdateDesc(update);
  let body = {};
  body[WEBHOOK_CONTENT_FIELD] = message
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  })
  .then((resp) => {
    if (resp.ok) {
      console.log(`Sent notification for ${update.cellId}`)
    } else {
      console.error(resp);
    }
  })
}

function getUpdateDesc({ cellId, summaries, newCell }) {
  const data = getCellData(cellId);
  summaries = Array.from(new Set(summaries));
  summaries = summaries.map((str) => `- ${str}`);
  const desc = [
    `${data.type} ${newCell ? 'created' : 'updated'}:\n\`${data.name}\``,
    ...summaries,
    `<${data.link}>`,
  ];
  return desc.join('\n');
}

function getCellData(id) {
  const kindMapping = {
    'PARENT': 'Cluster',
    'LEAF': 'Item',
  };
  let doc = cells[id];
  return {
    id: id,
    name: doc.data.title || 'Untitled',
    type: kindMapping[doc.data.kind],
    link: `https://app.nuclino.com/${NUCLINO_TEAM}/_/${id}`,
  };
}

function getMemberData(id) {
  const m = members[id];
  return m ? `${m.firstName} ${m.lastName[0]}.` : null;
}

function removeDuplicates(array) {
  return Array.from(new Set(array));
}

let killProcess = null;
async function startWatching() {
  const token = await updateToken();

  const socket = new WebSocket('wss://api.nuclino.com/syncing', {
    headers: getHeaders(token),
  });

  const connection = new ShareDB.Connection(socket);
  connection.on('state', state => {
    console.log(`new connection state: ${state}`);
    if (state === 'connected') {
      subscribeTeam(connection);
    } else if (state === 'disconnected') {
      startWatching();
    }
  });

  // restart every day to renew token
  if (!killProcess) {
    killProcess = setTimeout(() => process.exit(1), 24 * 60 * 60 * 1000);
  }
}

startWatching();
