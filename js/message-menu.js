// Плавающее меню: пассивный снимок сообщения, размещение в видимой области и фокус.
import {$, element} from './core.js';

let active = null;
const focusable = node => Array.from(node.querySelectorAll('button,input,[tabindex]')).filter(item => !item.disabled && item.tabIndex >= 0 && item.getClientRects().length && !item.closest('[inert]'));

function passiveClone(source) {
  // Медиа даже во временном отсоединённом дереве не клонируем: src может запустить загрузку.
  if(source.nodeType === 1 && source.matches('video,audio')) {
    const frame = element('canvas', 'sheet-media-frame');
    frame.width = source.videoWidth || 210; frame.height = source.videoHeight || 210;
    let painted = false;
    try {if(source.videoWidth && source.readyState >= 2) {frame.getContext('2d').drawImage(source, 0, 0, frame.width, frame.height); painted = true;}} catch(_error) {}
    return painted ? frame : element('span', 'sheet-media-frame');
  }
  const copy = source.cloneNode(false);
  source.childNodes.forEach(child => copy.appendChild(passiveClone(child)));
  return copy;
}

function previewOf(row) {
  const original = row.querySelector('.message-bubble'), bubble = passiveClone(original);
  [bubble, ...bubble.querySelectorAll('*')].forEach(node => {
    node.removeAttribute('id');
    Array.from(node.attributes).forEach(attr => {if(attr.name.startsWith('data-') || attr.name.startsWith('on')) node.removeAttribute(attr.name);});
    if(node.matches('button,input,textarea,select,a,[tabindex]')) {node.tabIndex = -1; node.removeAttribute('href');}
  });
  bubble.style.transform = ''; bubble.style.transition = ''; bubble.style.width = Math.ceil(original.getBoundingClientRect().width) + 'px';
  const preview = element('div', row.className + ' sheet-selected');
  preview.classList.remove('flash'); preview.setAttribute('aria-hidden', 'true'); preview.inert = true;
  preview.appendChild(bubble);
  return preview;
}

export function layoutMessageMenu() {
  if(!active) return;
  const viewport = window.visualViewport, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
  const layer = $('sheet-layer'), sheet = $('sheet'), anchor = active.row.querySelector('.message-bubble').getBoundingClientRect();
  Object.assign(layer.style, {left:left + 'px', top:top + 'px', width:width + 'px', height:height + 'px'});
  const safe = getComputedStyle(layer), inset = side => Math.max(12, parseFloat(safe['padding' + side]) + 8 || 12);
  const marginTop = inset('Top'), marginBottom = inset('Bottom'), marginLeft = inset('Left'), marginRight = inset('Right');
  const available = Math.max(120, height - marginTop - marginBottom), menuWidth = Math.min(352, width - marginLeft - marginRight);
  sheet.style.width = menuWidth + 'px'; sheet.style.maxHeight = available + 'px';
  active.preview.style.maxHeight = Math.max(36, Math.min(anchor.height, available * (sheet.classList.contains('expanded') ? .32 : .4))) + 'px';
  const picker = sheet.querySelector('.sheet-picker');
  if(picker) picker.style.maxHeight = Math.max(100, available * .66) + 'px';
  const own = active.row.classList.contains('own');
  sheet.classList.toggle('sheet-own', own);
  const x = Math.max(marginLeft, Math.min(width - menuWidth - marginRight, own ? anchor.right - left - menuWidth : anchor.left - left));
  const firstHeight = sheet.firstElementChild?.getBoundingClientRect().height || 0;
  const y = Math.max(marginTop, Math.min(height - sheet.getBoundingClientRect().height - marginBottom, anchor.top - top - firstHeight - 8));
  sheet.style.left = x + 'px'; sheet.style.top = y + 'px';
}

export function setMessageMenuPanels(before, after, expanded = false) {
  if(!active) return;
  const sheet = $('sheet');
  sheet.classList.toggle('expanded', expanded);
  sheet.replaceChildren(...[before, active.preview, after].filter(Boolean));
  layoutMessageMenu();
  sheet.tabIndex = -1; sheet.focus({preventScroll:true});
  // aria-hidden дополняет inert в старых браузерах, где свойство ещё не реализовано.
  $('chat').setAttribute('aria-hidden', 'true');
}

export function hideMessageMenu(restoreFocus = true) {
  if(!active) return;
  const previous = active; active = null;
  previous.observer.disconnect();
  window.removeEventListener('resize', layoutMessageMenu);
  previous.viewport?.removeEventListener('resize', layoutMessageMenu);
  previous.viewport?.removeEventListener('scroll', layoutMessageMenu);
  document.removeEventListener('keydown', trapFocus, true);
  $('chat').inert = previous.inert;
  if(previous.ariaHidden === null) $('chat').removeAttribute('aria-hidden'); else $('chat').setAttribute('aria-hidden', previous.ariaHidden);
  $('sheet-layer').hidden = true; $('sheet').replaceChildren(); $('sheet').classList.remove('expanded');
  if(restoreFocus && previous.focus?.isConnected) previous.focus.focus({preventScroll:true});
}

function trapFocus(event) {
  if(!active || event.key !== 'Tab') return;
  const items = focusable($('sheet')), index = items.indexOf(document.activeElement);
  event.preventDefault();
  const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
  items[next]?.focus({preventScroll:true});
}

export function showMessageMenu(row, valid, close) {
  hideMessageMenu(false);
  const preview = previewOf(row), chat = $('chat');
  let focus = document.activeElement;
  if(!focus || focus === document.body) {focus = row.querySelector('.message-bubble'); focus.tabIndex = -1;}
  active = {row, preview, focus, inert:chat.inert, ariaHidden:chat.getAttribute('aria-hidden'), viewport:window.visualViewport};
  chat.inert = true; $('sheet-layer').hidden = false;
  // Смена чата, выход, удаление или замена выбранного сообщения закрывают устаревшее меню.
  active.observer = new MutationObserver(() => {if(!row.isConnected || !valid()) close();});
  active.observer.observe($('messages'), {childList:true, subtree:true});
  window.addEventListener('resize', layoutMessageMenu);
  window.visualViewport?.addEventListener('resize', layoutMessageMenu);
  window.visualViewport?.addEventListener('scroll', layoutMessageMenu);
  document.addEventListener('keydown', trapFocus, true);
}
