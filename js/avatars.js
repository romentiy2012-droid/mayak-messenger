// Аватарки: готовые значки и небольшие фото из закрытого хранилища.
// Фото держим только в памяти текущего входа, без публичных URL и постоянного кэша.
export const AVATARS = [
  ['cat','🐱','Кот'], ['dog','🐶','Пёс'], ['fox','🦊','Лиса'], ['bear','🐻','Медведь'],
  ['panda','🐼','Панда'], ['owl','🦉','Сова'], ['wolf','🐺','Волк'], ['whale','🐳','Кит'],
  ['car','🚗','Машина'], ['rocket','🚀','Ракета'], ['ship','🚢','Корабль'], ['bike','🚲','Велосипед'],
  ['key','🔑','Ключ'], ['heart','❤️','Сердце'], ['star','⭐','Звезда'], ['sun','☀️','Солнце'],
  ['moon','🌙','Луна'], ['flower','🌻','Цветок'], ['tree','🌲','Ель'], ['cactus','🌵','Кактус'],
  ['guitar','🎸','Гитара'], ['ball','⚽','Мяч'], ['anchor','⚓','Якорь'], ['compass','🧭','Компас']
];
const icons = new Map(AVATARS.map(([id, emoji]) => [id, emoji]));
const photos = new Map();
let generation = 0;
export function clearAvatarPhotos() {
  generation++;
  photos.forEach(pending => pending.then(url => URL.revokeObjectURL(url)).catch(() => {}));
  photos.clear();
  document.querySelectorAll('.avatar[data-avatar-key]').forEach(node => {delete node.dataset.avatarKey; if(node.classList.contains('avatar-photo')) {node.textContent = letters(node.dataset.avatarName); node.classList.remove('avatar-photo');}});
}
function photoURL(path) {
  if(!photos.has(path)) {
    const current = generation;
    const pending = window.MayakCloud.avatarDownload(path).then(blob => {
      if(current !== generation) throw new Error('Вход изменился.');
      return URL.createObjectURL(blob);
    });
    photos.set(path, pending);
    pending.catch(() => {if(photos.get(path) === pending) photos.delete(path);});
  }
  return photos.get(path);
}
function letters(name) {return String(name || '?').split(/\s+/).filter(Boolean).slice(0,2).map(word => Array.from(word)[0]).join('').toUpperCase();}
export function paintAvatar(node, user) {
  const key = [user.id, user.name, user.avatar_icon, user.avatar_file, user.preview_url].join('|');
  if(node.dataset.avatarKey === key) return node;
  node.dataset.avatarKey = key; node.dataset.avatarId = user.id || '';
  node.dataset.avatarName = user.name || '?';
  node.classList.remove('avatar-emoji', 'avatar-photo');
  node.textContent = letters(user.name); node.setAttribute('aria-hidden', 'true');
  if(icons.has(user.avatar_icon)) {
    node.textContent = icons.get(user.avatar_icon); node.classList.add('avatar-emoji');
  } else if(user.avatar_file || user.preview_url) {
    const pending = user.preview_url ? Promise.resolve(user.preview_url) : photoURL(user.avatar_file);
    pending.then(url => {
      if(node.dataset.avatarKey !== key) return;
      const image = new Image(); image.alt = ''; image.decoding = 'async';
      image.onload = () => {if(node.dataset.avatarKey === key) {node.replaceChildren(image); node.classList.add('avatar-photo');}};
      image.src = url;
    }).catch(() => {}); // при недоступном фото остаются буквы
  }
  return node;
}
async function prepareAvatar(file) {
  if(!file || !/^image\//.test(file.type || '')) throw new Error('Выберите фото из галереи.');
  if(file.size > 20 * 1024 * 1024) throw new Error('Фото больше 20 МБ. Выберите изображение поменьше.');
  const url = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise((resolve, reject) => {image.onload = resolve; image.onerror = () => reject(new Error('Не удалось прочитать фото. Выберите другое.')); image.src = url;});
    const width = image.naturalWidth, height = image.naturalHeight, side = Math.min(width, height);
    if(!side) throw new Error('Не удалось прочитать фото.');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 384;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 384, 384);
    context.drawImage(image, (width-side)/2, (height-side)/2, side, side, 0, 0, 384, 384);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .85));
    if(!blob || blob.size > 512000) throw new Error('Не удалось уменьшить фото. Выберите другое.');
    return blob; // JPEG без исходных метаданных снимка
  } finally {URL.revokeObjectURL(url);}
}
export function avatarEditor(user) {
  const field = document.createElement('fieldset'); field.className = 'avatar-editor';
  const legend = document.createElement('legend'); legend.textContent = 'Ваша аватарка'; field.appendChild(legend);
  const heading = document.createElement('div'); heading.className = 'avatar-preview-row';
  const preview = document.createElement('span'); preview.className = 'avatar avatar-preview';
  const note = document.createElement('p'); note.className = 'about-note'; note.textContent = 'Фото или значок — его увидят участники чата.';
  heading.append(preview, note); field.appendChild(heading);
  const actions = document.createElement('div'); actions.className = 'avatar-actions';
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.hidden = true; input.setAttribute('aria-label', 'Фото для аватарки');
  const upload = document.createElement('button'); upload.type = 'button'; upload.className = 'quiet-button'; upload.textContent = 'Выбрать фото';
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'quiet-button'; reset.textContent = 'Оставить буквы';
  actions.append(upload, reset, input); field.appendChild(actions);
  const grid = document.createElement('div'); grid.className = 'avatar-options'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', 'Готовые аватарки');
  const status = document.createElement('p'); status.className = 'about-note avatar-status'; status.setAttribute('role', 'status');
  field.append(grid, status);
  const error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'alert'); field.appendChild(error);
  let icon = user.avatar_icon || null, file = user.avatar_file || null, blob = null, previewURL = null, token = 0, disposed = false, processing = false, committed = false;
  const revoke = () => {if(previewURL) URL.revokeObjectURL(previewURL); previewURL = null;};
  const discardUpload = () => {if(!committed && blob && file && file !== user.avatar_file) window.MayakCloud.avatarRemove(file).catch(() => {});};
  function paint() {
    paintAvatar(preview, {...user, avatar_icon:icon, avatar_file:file, preview_url:previewURL});
    grid.querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.icon === icon)));
    reset.setAttribute('aria-pressed', String(!icon && !file && !blob));
  }
  for(const [id, emoji, label] of AVATARS) {
    const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'avatar-option'; choice.dataset.icon = id;
    choice.textContent = emoji; choice.title = label; choice.setAttribute('aria-label', label);
    choice.addEventListener('click', () => {token++; discardUpload(); revoke(); icon = id; file = null; blob = null; error.textContent = ''; status.textContent = ''; paint();});
    grid.appendChild(choice);
  }
  upload.addEventListener('click', () => input.click());
  reset.addEventListener('click', () => {token++; discardUpload(); revoke(); icon = file = blob = null; error.textContent = ''; status.textContent = ''; paint();});
  input.addEventListener('change', async () => {
    const chosen = input.files[0]; input.value = ''; if(!chosen) return;
    const current = ++token; processing = true; field.disabled = true; error.textContent = ''; status.textContent = 'Готовим фото…';
    try {
      const prepared = await prepareAvatar(chosen);
      if(disposed || current !== token) return;
      discardUpload(); revoke(); blob = prepared; previewURL = URL.createObjectURL(blob); icon = file = null;
      status.textContent = 'Фото обрезано по центру. Проверьте его перед сохранением.'; paint();
    } catch(reason) {if(!disposed && current === token) {error.textContent = reason.message; status.textContent = '';}}
    finally {processing = false; if(!disposed) field.disabled = false;}
  });
  paint();
  return {
    node:field,
    busy:() => processing,
    disable(value) {field.disabled = value;},
    async value() {
      if(blob && !file) file = await window.MayakCloud.avatarUpload(blob);
      return {avatar_icon:icon, avatar_file:file};
    },
    commit() {committed = true;},
    dispose() {
      disposed = true; token++; revoke();
      // После неуспешной попытки оставляем в хранилище только опубликованное фото.
      // Если ответ потерялся после записи, правило DELETE защитит действующий файл.
      discardUpload();
    }
  };
}
