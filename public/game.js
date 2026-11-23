'use strict';

// HOTEL 96 — client. The server remains authoritative for every game rule.
const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
const $ = (id) => document.getElementById(id);
const joinScreen = $('joinScreen');
const gameScreen = $('gameScreen');
const joinForm = $('joinForm');
const joinError = $('joinError');
const floorChoice = $('floorChoice');
const building = $('building');
const onlineCount = $('onlineCount');
const toast = $('toast');
const serverStatus = $('serverStatus');

let selfId = null;
let selfPlayer = null;
let latestState = null;
let toastTimer = null;
let previousFloor = null;

const faNumber = (number) => new Intl.NumberFormat('fa-IR').format(number);
const floorTitle = (floor) => floor < 0
  ? `منفی ${faNumber(Math.abs(floor))}`
  : floor === 0 ? 'صفر' : faNumber(floor);

// The available floor choices intentionally do not reveal live occupancy.
for (let floor = 1; floor <= 24; floor += 1) {
  const option = document.createElement('option');
  option.value = String(floor);
  option.textContent = `طبقه ${faNumber(floor)}`;
  if (floor === 12) option.selected = true;
  floorChoice.appendChild(option);
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3000);
}

function showJoinError(message) {
  joinError.textContent = message;
  joinError.hidden = false;
}

function setServerStatus(text, connected) {
  if (!serverStatus) return;
  serverStatus.textContent = text;
  serverStatus.classList.toggle('connected', Boolean(connected));
  serverStatus.classList.toggle('disconnected', !connected);
}

function updatePlayerPanel() {
  if (!selfPlayer) return;
  $('myName').textContent = selfPlayer.name;
  $('myAvatar').textContent = selfPlayer.name.slice(0, 1);
  $('myAvatar').style.background = selfPlayer.color;
  $('myFloor').textContent = floorTitle(selfPlayer.floor);
  const keyStatus = $('keyStatus');
  keyStatus.classList.toggle('has-key', selfPlayer.hasKey);
  keyStatus.replaceChildren();
  const icon = document.createElement('span');
  icon.textContent = selfPlayer.hasKey ? '🗝️' : '🔒';
  const label = document.createElement('small');
  label.textContent = selfPlayer.hasKey ? 'کلید داری' : 'کلید نداری';
  keyStatus.append(icon, label);
}

function makeRoom(slot, occupant) {
  const room = document.createElement('div');
  room.className = `room ${occupant ? 'occupied' : 'empty'}`;
  if (occupant && occupant.id === selfId) room.classList.add('me');
  room.setAttribute('aria-label', occupant
    ? `خانه ${faNumber(slot + 1)}: ${occupant.name}`
    : `خانه خالی ${faNumber(slot + 1)}`);

  const windowShape = document.createElement('span');
  windowShape.className = 'room-window';
  room.appendChild(windowShape);

  if (occupant) {
    const figure = document.createElement('span');
    figure.className = 'room-figure';
    figure.style.setProperty('--avatar-color', occupant.color || '#d39b64');
    const name = document.createElement('span');
    name.className = 'room-name';
    name.textContent = occupant.id === selfId ? `${occupant.name} (تو)` : occupant.name;
    room.append(figure, name);
  } else {
    const emptyLabel = document.createElement('span');
    emptyLabel.className = 'empty-room-label';
    emptyLabel.textContent = 'خالی';
    room.appendChild(emptyLabel);
  }
  return room;
}

function makeFloorRow(floor, people) {
  const row = document.createElement('section');
  row.className = 'floor-row';
  row.id = `floor-row-${floor < 0 ? `m${Math.abs(floor)}` : floor}`;
  row.dataset.floor = String(floor);
  if (floor === selfPlayer.floor) row.classList.add('mine');
  if (floor < 0) row.classList.add('negative-floor');
  if (floor > selfPlayer.floor) row.classList.add('above');
  if (floor === 0 && !selfPlayer.hasKey) row.classList.add('locked-floor');
  if (floor === 1) row.classList.add('key-floor');

  const number = document.createElement('span');
  number.className = 'floor-number';
  number.textContent = floor < 0 ? `−${faNumber(Math.abs(floor))}` : faNumber(floor);
  row.appendChild(number);

  const label = document.createElement('span');
  label.className = 'floor-label';
  if (floor === selfPlayer.floor) label.textContent = 'طبقه تو';
  else if (floor === 0) label.textContent = selfPlayer.hasKey ? 'در باز است' : 'درِ قفل‌دار';
  else if (floor < 0) label.textContent = 'جاذبه برعکس';
  else label.textContent = '';
  row.appendChild(label);

  // Rooms are placed on the right; elevator shaft sits a little left of center.
  const roomArea = document.createElement('div');
  roomArea.className = 'room-area';
  for (let slot = 0; slot < 4; slot += 1) roomArea.appendChild(makeRoom(slot, people[slot] || null));
  row.appendChild(roomArea);

  const lift = document.createElement('div');
  lift.className = 'lift-cell';
  const shaft = document.createElement('div');
  shaft.className = 'lift-shaft';
  const door = document.createElement('div');
  door.className = `lift-door${floor === selfPlayer.floor ? ' current' : ''}`;
  door.textContent = floor === selfPlayer.floor ? '●' : 'Ⅱ';
  shaft.appendChild(door);
  lift.appendChild(shaft);

  const move = document.createElement('button');
  move.type = 'button';
  move.className = 'move-btn';
  move.textContent = floor === selfPlayer.floor ? 'اینجایی' : '↓ برو';
  move.disabled = floor >= selfPlayer.floor
    || (floor < 0 && selfPlayer.floor > 0)
    || (floor === 0 && !selfPlayer.hasKey);
  if (floor === selfPlayer.floor) move.setAttribute('aria-current', 'location');
  move.addEventListener('click', () => moveToFloor(floor));
  lift.appendChild(move);
  row.appendChild(lift);

  const count = document.createElement('span');
  count.className = 'floor-count';
  count.textContent = `${faNumber(people.length)} از ۴`;
  row.appendChild(count);

  if (floor === 1) {
    const keyButton = document.createElement('button');
    keyButton.type = 'button';
    keyButton.className = 'key-button';
    keyButton.textContent = selfPlayer.hasKey ? '✓ کلید برداشته شد' : '🗝 برداشتن کلید';
    keyButton.disabled = selfPlayer.floor !== 1 || selfPlayer.hasKey;
    keyButton.addEventListener('click', collectKey);
    row.appendChild(keyButton);
  }

  if (floor < 0) {
    const special = document.createElement('span');
    special.className = 'floor-special';
    special.textContent = '↑ سقف = زمین';
    row.appendChild(special);
  }
  return row;
}

function renderBuilding(state) {
  if (!selfPlayer) return;
  const occupants = new Map();
  for (const person of state.players) {
    if (!occupants.has(person.floor)) occupants.set(person.floor, []);
    occupants.get(person.floor).push(person);
  }
  const rows = [];
  for (let floor = 24; floor >= -3; floor -= 1) {
    rows.push(makeFloorRow(floor, occupants.get(floor) || []));
  }
  building.replaceChildren(...rows);
}

function updateWorld(state) {
  if (!state || !Array.isArray(state.players)) return;
  latestState = state;
  onlineCount.textContent = faNumber(state.online || 0);
  if (!selfId) return;

  const updated = state.players.find((person) => person.id === selfId);
  if (!updated) {
    selfId = null;
    selfPlayer = null;
    previousFloor = null;
    gameScreen.hidden = true;
    joinScreen.hidden = false;
    showToast('از بازی خارج شدی یا ارتباطت قطع شد. دوباره وارد شو.', true);
    return;
  }

  const oldFloor = previousFloor;
  selfPlayer = updated;
  updatePlayerPanel();
  renderBuilding(state);
  if (oldFloor !== null && oldFloor !== selfPlayer.floor) {
    const targetRow = $(`floor-row-${selfPlayer.floor < 0 ? `m${Math.abs(selfPlayer.floor)}` : selfPlayer.floor}`);
    if (targetRow) targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  previousFloor = selfPlayer.floor;
}

function moveToFloor(floor) {
  socket.emit('moveFloor', { floor }, (response) => {
    if (!response || !response.ok) {
      showToast(response?.message || 'حرکت انجام نشد.', true);
      return;
    }
    showToast(response.message || 'به طبقه جدید رسیدی.');
  });
}

function collectKey() {
  socket.emit('collectKey', {}, (response) => {
    showToast(response?.message || 'کلید دریافت نشد.', !response?.ok);
  });
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  joinError.hidden = true;
  if (!socket.connected) {
    showJoinError('هنوز به سرور وصل نشده‌ای. اول سرور را روشن کن و دوباره تلاش کن.');
    return;
  }

  const name = $('playerName').value.trim();
  const floor = Number(floorChoice.value);
  const submit = joinForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = 'در حال ورود…';

  socket.emit('join', { name, floor }, (response) => {
    submit.disabled = false;
    submit.innerHTML = 'ورود به هتل <span>←</span>';
    if (!response?.ok) {
      showJoinError(response?.message || 'ورود به هتل انجام نشد.');
      return;
    }
    selfId = response.playerId;
    selfPlayer = response.player;
    previousFloor = selfPlayer.floor;
    joinScreen.hidden = true;
    gameScreen.hidden = false;
    updatePlayerPanel();
    if (latestState) renderBuilding(latestState);
    $('bottomHint').textContent = selfPlayer.floor === 1
      ? 'برای باز کردن طبقه صفر، کلید را در همین طبقه بردار. سپس می‌توانی وارد زیرزمین شوی.'
      : 'با آسانسور فقط به طبقه پایین‌تر می‌روی؛ راه برگشت به طبقات بالا بسته است.';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast(`به هتل خوش آمدی ${selfPlayer.name}!`);
  });
});

socket.on('worldState', updateWorld);
socket.on('connect', () => {
  setServerStatus('سرور وصل است', true);
  if (selfId) showToast('اتصال به سرور برقرار شد.');
});
socket.on('disconnect', () => {
  setServerStatus('ارتباط قطع شد', false);
  if (selfId) showToast('ارتباط با سرور قطع شد؛ در حال تلاش برای اتصال دوباره…', true);
});
socket.on('connect_error', () => {
  setServerStatus('سرور در دسترس نیست', false);
});

$('rulesButton').addEventListener('click', () => {
  $('rulesPanel').hidden = !$('rulesPanel').hidden;
});
$('closeRules').addEventListener('click', () => $('rulesDialog').close());
