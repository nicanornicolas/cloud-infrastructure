"use strict";

// Custom gauge metrics read by the "lockers offline" alert (descriptors are created in terraform/monitoring.tf,
// so the alert policy can be created before the first data point exists).
const METRIC_OFFLINE = "custom.googleapis.com/lockers/offline";
const METRIC_ONLINE = "custom.googleapis.com/lockers/online";

function buildTimeSeries(projectId, { online, offline, now }) {
  const point = (value) => ({
    interval: { endTime: { seconds: Math.floor(now / 1000), nanos: 0 } },
    value: { int64Value: value },
  });
  const series = (type, value) => ({
    metric: { type },
    resource: { type: "global", labels: { project_id: projectId } },
    points: [point(value)],
  });
  return [series(METRIC_OFFLINE, offline), series(METRIC_ONLINE, online)];
}

function createGaugeWriter(client, projectId) {
  return ({ online, offline, now }) =>
    client.createTimeSeries({ name: client.projectPath(projectId), timeSeries: buildTimeSeries(projectId, { online, offline, now }) });
}

module.exports = { METRIC_OFFLINE, METRIC_ONLINE, buildTimeSeries, createGaugeWriter };
