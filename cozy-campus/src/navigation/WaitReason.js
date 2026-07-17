export const WaitReason = {
    QUEUE_HEAD:     "QUEUE_HEAD",
    QUEUE_FIRST:    "QUEUE_FIRST",
    LANE_FULL:      "LANE_FULL",
    NODE_OCCUPIED:  "NODE_OCCUPIED",
    ENDPOINT_WAIT:  "ENDPOINT_WAIT",
    HARD_BLOCKED:   "HARD_BLOCKED",
    REALIGNING:     "REALIGNING",
    DWELL_COOLDOWN: "DWELL_COOLDOWN"
};

export const WaitReasonLabel = {
    [WaitReason.QUEUE_HEAD]:     "waiting for queue head",
    [WaitReason.QUEUE_FIRST]:    "first in queue (turnaround)",
    [WaitReason.LANE_FULL]:      "no lane available",
    [WaitReason.NODE_OCCUPIED]:  "node is occupied",
    [WaitReason.ENDPOINT_WAIT]:  "waiting at lane endpoint",
    [WaitReason.HARD_BLOCKED]:   "hard-blocked",
    [WaitReason.REALIGNING]:     "returning to graph axis",
    [WaitReason.DWELL_COOLDOWN]: "dwell spot cooldown"
};
