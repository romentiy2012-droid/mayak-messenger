const {test} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const timingModule = import('data:text/javascript;base64,' + fs.readFileSync('js/voice-timing.js').toString('base64'));
function buffer(duration, sounds = [], channels = 1) {
  const sampleRate = 8000, data = Array.from({length:channels}, () => new Float32Array(duration * sampleRate));
  for(const [channel, from, to, amplitude = .2] of sounds) data[channel].fill(amplitude, from * sampleRate, to * sampleRate);
  return {duration, sampleRate, numberOfChannels:channels, getChannelData:channel => data[channel]};
}
test('voice timing: long empty tail, internal pauses, quiet speech, stereo and silence', async () => {
  const {voiceTiming} = await timingModule;
  assert.deepEqual(voiceTiming(buffer(92, [[0, 0, 2]])), {duration:92, end:2.25});
  assert.equal(voiceTiming(buffer(12, [[0, 0, 1], [0, 10, 12]])).end, 12, 'long internal pause remains');
  assert.equal(voiceTiming(buffer(20, [[0, 0, 2], [0, 15, 19, .0001]])).end, 20, 'very quiet ending remains');
  assert.equal(voiceTiming(buffer(20, [[0, 0, 2], [1, 18, 20]], 2)).end, 20, 'last sound in any channel counts');
  assert.equal(voiceTiming(buffer(4, [[0, 0, 2]])).end, 4, 'short trailing pause remains');
  assert.equal(voiceTiming(buffer(20)).end, 20, 'fully silent recording has no speech boundary');
  assert.equal(voiceTiming({duration:NaN}), null);
});
