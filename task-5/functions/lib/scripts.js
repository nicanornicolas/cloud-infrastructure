"use strict";

// Redis keys
//   lockers:last_seen   ZSET  member=lockerId score=lastSeen (ms)      -> offline sweep + online count
//   locker:{id}         HASH  status, statusVersion, statusSince, lastSeen, temperature, doors, lastSync, dirty
//   lockers:dirty       SET   lockers whose Firestore copy is behind Redis -> retried by the reconciler
//   stats:heartbeats    STRING heartbeat counter since the last roll-up
const KEYS = Object.freeze({
  lastSeen: "lockers:last_seen",
  dirty: "lockers:dirty",
  heartbeatCount: "stats:heartbeats",
  locker: (id) => `locker:${id}`,
});

// Lua scripts run atomically in Redis: a heartbeat and the offline sweep can never interleave, so
// "read status, then write status" races are impossible. Redis is the single serialisation point
// for a locker's state; `statusVersion` orders status changes for the Firestore copy.
// (Standalone Memorystore. Under Redis Cluster, keys would need a shared hash tag.)

// KEYS: lastSeen zset, dirty set, heartbeat counter, locker hash
// ARGV: lockerId, tsMs, temperature, doorsJson, checkpointMs
// -> { "stale"|"ok", dirty (0/1), transitionedOnline (0/1) }
const HEARTBEAT = `
local ts = tonumber(ARGV[2])
local last = tonumber(redis.call('HGET', KEYS[4], 'lastSeen') or '0')
if ts <= last then
  -- duplicate or out-of-order redelivery: never move state backwards
  return {'stale', redis.call('HEXISTS', KEYS[4], 'dirty'), 0}
end
redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[1], ts, ARGV[1])
local status = redis.call('HGET', KEYS[4], 'status')
local prevDoors = redis.call('HGET', KEYS[4], 'doors')
local lastSync = tonumber(redis.call('HGET', KEYS[4], 'lastSync') or '0')
redis.call('HSET', KEYS[4], 'lastSeen', ARGV[2], 'temperature', ARGV[3], 'doors', ARGV[4])
local transition = 0
if status ~= 'online' then
  redis.call('HINCRBY', KEYS[4], 'statusVersion', 1)
  redis.call('HSET', KEYS[4], 'status', 'online', 'statusSince', ARGV[2])
  transition = 1
end
if transition == 1 or prevDoors ~= ARGV[4] or (ts - lastSync) >= tonumber(ARGV[5]) then
  redis.call('HSET', KEYS[4], 'dirty', ARGV[2])
  redis.call('SADD', KEYS[2], ARGV[1])
end
return {'ok', redis.call('HEXISTS', KEYS[4], 'dirty'), transition}
`;

// KEYS: lastSeen zset, dirty set   ARGV: cutoffMs, nowMs, limit
// -> array of lockerIds that went online -> offline in this call
const MARK_OFFLINE = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[3]))
local out = {}
for _, id in ipairs(ids) do
  local key = 'locker:' .. id
  if redis.call('HGET', key, 'status') == 'online' then
    redis.call('HINCRBY', key, 'statusVersion', 1)
    redis.call('HSET', key, 'status', 'offline', 'statusSince', ARGV[2], 'dirty', ARGV[2])
    redis.call('SADD', KEYS[2], id)
    out[#out + 1] = id
  end
end
return out
`;

// KEYS: locker hash, dirty set   ARGV: lockerId, dirtyValueThatWasSynced, syncedLastSeen
// Clears the dirty mark only if nothing changed since the snapshot that was written to Firestore.
const CLEAR_DIRTY = `
if redis.call('HGET', KEYS[1], 'dirty') == ARGV[2] then
  redis.call('HDEL', KEYS[1], 'dirty')
  redis.call('HSET', KEYS[1], 'lastSync', ARGV[3])
  redis.call('SREM', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

function defineScripts(redis) {
  redis.defineCommand("heartbeat", { numberOfKeys: 4, lua: HEARTBEAT });
  redis.defineCommand("markOffline", { numberOfKeys: 2, lua: MARK_OFFLINE });
  redis.defineCommand("clearDirty", { numberOfKeys: 2, lua: CLEAR_DIRTY });
  return redis;
}

module.exports = { KEYS, defineScripts };
