const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
|--------------------------------------------------------------------------
| In-memory state
|--------------------------------------------------------------------------
|
| This keeps the current architecture simple.
| Restarting the server clears active groups.
|
*/

const groups = new Map();

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function now() {
  return Date.now();
}

function generateGroupCode() {
  let code;

  do {
    code = crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase();
  } while (groups.has(code));

  return code;
}

function sanitizeMember(member) {
  if (!member) return null;

  return {
    userId: member.userId,
    name: member.name || "Rider",

    lat: typeof member.lat === "number" ? member.lat : null,
    lng: typeof member.lng === "number" ? member.lng : null,

    heading:
      typeof member.heading === "number"
        ? member.heading
        : null,

    connected: !!member.connected,

    /*
     * Last time this rider successfully sent
     * a location/update to the server.
     */
    lastSeen:
      typeof member.lastSeen === "number"
        ? member.lastSeen
        : null,

    /*
     * Socket ID is deliberately not exposed.
     */
    isLeader: !!member.isLeader,
  };
}

function serializeGroup(group) {
  return {
    code: group.code,

    leaderId: group.leaderId,

    destination: group.destination || null,

    route: group.route || null,

    alternatives: Array.isArray(group.alternatives)
      ? group.alternatives
      : [],

    stops: Array.isArray(group.stops)
      ? group.stops
      : [],

    members: Array.from(group.members.values()).map(
      sanitizeMember
    ),

    createdAt: group.createdAt,
  };
}

function emitGroupState(group) {
  io.to(group.code).emit(
    "group_state",
    serializeGroup(group)
  );
}

function getGroupFromSocket(socket) {
  const code = socket.data.groupCode;

  if (!code) return null;

  return groups.get(code) || null;
}

function getMemberFromSocket(socket) {
  const group = getGroupFromSocket(socket);

  if (!group) return null;

  const userId = socket.data.userId;

  if (!userId) return null;

  return group.members.get(userId) || null;
}

/*
|--------------------------------------------------------------------------
| Health check
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ride-tracker-server",
    groups: groups.size,
    time: now(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: now(),
    groups: groups.size,
  });
});

/*
|--------------------------------------------------------------------------
| Create group
|--------------------------------------------------------------------------
*/

app.post("/groups", (req, res) => {
  const body = req.body || {};

  const userId =
    typeof body.userId === "string" && body.userId.trim()
      ? body.userId.trim()
      : crypto.randomUUID();

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : "Rider";

  const code = generateGroupCode();

  const group = {
    code,

    leaderId: userId,

    destination: null,

    route: null,

    alternatives: [],

    stops: [],

    createdAt: now(),

    members: new Map(),
  };

  group.members.set(userId, {
    userId,
    name,

    lat: null,
    lng: null,
    heading: null,

    connected: false,

    lastSeen: null,

    isLeader: true,

    socketId: null,
  });

  groups.set(code, group);

  res.json({
    ok: true,
    code,
    userId,
    group: serializeGroup(group),
  });
});

/*
|--------------------------------------------------------------------------
| Get group
|--------------------------------------------------------------------------
*/

app.get("/groups/:code", (req, res) => {
  const code = String(req.params.code || "")
    .trim()
    .toUpperCase();

  const group = groups.get(code);

  if (!group) {
    return res.status(404).json({
      ok: false,
      error: "Group not found",
    });
  }

  res.json({
    ok: true,
    group: serializeGroup(group),
  });
});

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {
  console.log(
    `[socket] connected ${socket.id}`
  );

  /*
  |--------------------------------------------------------------------------
  | Join group
  |--------------------------------------------------------------------------
  */

  socket.on("join_group", (payload = {}, callback) => {
    try {
      const code = String(payload.code || "")
        .trim()
        .toUpperCase();

      const userId =
        typeof payload.userId === "string" &&
        payload.userId.trim()
          ? payload.userId.trim()
          : crypto.randomUUID();

      const name =
        typeof payload.name === "string" &&
        payload.name.trim()
          ? payload.name.trim()
          : "Rider";

      if (!code) {
        if (typeof callback === "function") {
          callback({
            ok: false,
            error: "Group code is required",
          });
        }

        return;
      }

      const group = groups.get(code);

      if (!group) {
        if (typeof callback === "function") {
          callback({
            ok: false,
            error: "Group not found",
          });
        }

        return;
      }

      /*
      |--------------------------------------------------------------------------
      | If this user already exists, reuse the existing member.
      |
      | This is important for reconnects.
      |--------------------------------------------------------------------------
      */

      let member = group.members.get(userId);

      if (!member) {
        member = {
          userId,
          name,

          lat: null,
          lng: null,
          heading: null,

          connected: true,

          lastSeen: now(),

          isLeader: userId === group.leaderId,

          socketId: socket.id,
        };

        group.members.set(userId, member);
      } else {
        member.name = name || member.name;
        member.connected = true;
        member.socketId = socket.id;

        /*
         * Do not destroy the previous location.
         * This lets other riders see the last known position
         * while the phone reconnects.
         */

        member.lastSeen = now();
      }

      socket.data.groupCode = code;
      socket.data.userId = userId;

      socket.join(code);

      /*
      |--------------------------------------------------------------------------
      | Send complete current state immediately.
      |
      | This handles late joiners.
      |--------------------------------------------------------------------------
      */

      socket.emit(
        "group_state",
        serializeGroup(group)
      );

      /*
      |--------------------------------------------------------------------------
      | Tell everybody that membership/connection state changed.
      |--------------------------------------------------------------------------
      */

      emitGroupState(group);

      if (typeof callback === "function") {
        callback({
          ok: true,
          userId,
          group: serializeGroup(group),
        });
      }

      console.log(
        `[join] ${name} (${userId}) joined ${code}`
      );
    } catch (error) {
      console.error(
        "[join_group] error:",
        error
      );

      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Failed to join group",
        });
      }
    }
  });

  /*
  |--------------------------------------------------------------------------
  | Location update
  |--------------------------------------------------------------------------
  */

  socket.on("location_update", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    const heading =
      payload.heading == null
        ? null
        : Number(payload.heading);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return;
    }

    member.lat = lat;
    member.lng = lng;

    if (Number.isFinite(heading)) {
      member.heading = heading;
    }

    member.connected = true;

    /*
     * THIS is the important lastSeen update.
     */

    member.lastSeen = now();

    /*
     * Location updates are sent to the whole group.
     */

    io.to(group.code).emit(
      "location_update",
      {
        userId: member.userId,
        name: member.name,

        lat: member.lat,
        lng: member.lng,

        heading: member.heading,

        connected: true,

        lastSeen: member.lastSeen,
      }
    );
  });

  /*
  |--------------------------------------------------------------------------
  | Explicit heartbeat
  |--------------------------------------------------------------------------
  |
  | Useful when GPS does not move but the phone is still connected.
  |
  */

  socket.on("heartbeat", () => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    member.connected = true;
    member.lastSeen = now();

    socket.emit("heartbeat_ack", {
      time: member.lastSeen,
    });

    /*
     * No need to spam the entire group with every heartbeat.
     * The server's member state is refreshed.
     */
  });

  /*
  |--------------------------------------------------------------------------
  | Destination
  |--------------------------------------------------------------------------
  */

  socket.on("set_destination", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    /*
     * Only leader can change shared destination.
     */

    if (group.leaderId !== member.userId) {
      socket.emit("server_error", {
        message: "Only the group leader can change destination.",
      });

      return;
    }

    group.destination = payload.destination || null;

    /*
     * Keep route information if supplied.
     */

    if (payload.route !== undefined) {
      group.route = payload.route || null;
    }

    if (payload.alternatives !== undefined) {
      group.alternatives = Array.isArray(
        payload.alternatives
      )
        ? payload.alternatives
        : [];
    }

    emitGroupState(group);
  });

  /*
  |--------------------------------------------------------------------------
  | Clear destination
  |--------------------------------------------------------------------------
  */

  socket.on("clear_destination", () => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    if (group.leaderId !== member.userId) {
      socket.emit("server_error", {
        message: "Only the group leader can clear destination.",
      });

      return;
    }

    group.destination = null;
    group.route = null;
    group.alternatives = [];

    emitGroupState(group);
  });

  /*
  |--------------------------------------------------------------------------
  | Route update
  |--------------------------------------------------------------------------
  */

  socket.on("route_update", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    if (group.leaderId !== member.userId) {
      socket.emit("server_error", {
        message: "Only the group leader can update the route.",
      });

      return;
    }

    if (payload.route !== undefined) {
      group.route = payload.route || null;
    }

    if (payload.alternatives !== undefined) {
      group.alternatives = Array.isArray(
        payload.alternatives
      )
        ? payload.alternatives
        : [];
    }

    emitGroupState(group);
  });

  /*
  |--------------------------------------------------------------------------
  | Select route
  |--------------------------------------------------------------------------
  */

  socket.on("select_route", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    if (group.leaderId !== member.userId) {
      socket.emit("server_error", {
        message: "Only the group leader can select a route.",
      });

      return;
    }

    const index = Number(payload.index);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= group.alternatives.length
    ) {
      socket.emit("server_error", {
        message: "Invalid route index.",
      });

      return;
    }

    const selected =
      group.alternatives[index];

    if (!selected) return;

    group.route = selected;

    emitGroupState(group);
  });

  /*
  |--------------------------------------------------------------------------
  | Stops
  |--------------------------------------------------------------------------
  */

  socket.on("set_stops", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    if (group.leaderId !== member.userId) {
      socket.emit("server_error", {
        message: "Only the group leader can change stops.",
      });

      return;
    }

    group.stops = Array.isArray(payload.stops)
      ? payload.stops
      : [];

    emitGroupState(group);
  });

  socket.on("add_stop", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    if (group.leaderId !== member.userId) {
      socket.emit("server_error", {
        message: "Only the group leader can add stops.",
      });

      return;
    }

    if (!payload.stop) return;

    if (!Array.isArray(group.stops)) {
      group.stops = [];
    }

    group.stops.push(payload.stop);

    emitGroupState(group);
  });

  socket.on("remove_stop", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    if (group.leaderId !== member.userId) {
      socket.emit("server_error", {
        message: "Only the group leader can remove stops.",
      });

      return;
    }

    const index = Number(payload.index);

    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < group.stops.length
    ) {
      group.stops.splice(index, 1);
    }

    emitGroupState(group);
  });

  /*
  |--------------------------------------------------------------------------
  | SOS
  |--------------------------------------------------------------------------
  */

  socket.on("sos", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    const sos = {
      userId: member.userId,
      name: member.name,

      lat:
        Number.isFinite(Number(payload.lat))
          ? Number(payload.lat)
          : member.lat,

      lng:
        Number.isFinite(Number(payload.lng))
          ? Number(payload.lng)
          : member.lng,

      heading:
        payload.heading == null
          ? member.heading
          : Number(payload.heading),

      active: true,

      createdAt: now(),
    };

    member.lastSeen = now();

    io.to(group.code).emit(
      "sos",
      sos
    );
  });

  /*
  |--------------------------------------------------------------------------
  | Resolve SOS
  |--------------------------------------------------------------------------
  */

  socket.on("resolve_sos", (payload = {}) => {
    const group = getGroupFromSocket(socket);

    if (!group) return;

    const userId =
      typeof payload.userId === "string"
        ? payload.userId
        : null;

    io.to(group.code).emit(
      "sos_resolved",
      {
        userId,
        resolvedBy: socket.data.userId,
        resolvedAt: now(),
      }
    );
  });

  /*
  |--------------------------------------------------------------------------
  | Focus rider
  |--------------------------------------------------------------------------
  */

  socket.on("focus_rider", (payload = {}) => {
    const group = getGroupFromSocket(socket);

    if (!group) return;

    const userId =
      typeof payload.userId === "string"
        ? payload.userId
        : null;

    if (!userId) return;

    const member = group.members.get(userId);

    if (!member) return;

    socket.emit(
      "focus_rider",
      sanitizeMember(member)
    );
  });

  /*
  |--------------------------------------------------------------------------
  | Generic trip state
  |--------------------------------------------------------------------------
  |
  | Kept for compatibility with clients that send a complete trip state.
  |
  */

  socket.on("trip_state", (payload = {}) => {
    const group = getGroupFromSocket(socket);
    const member = getMemberFromSocket(socket);

    if (!group || !member) return;

    if (group.leaderId !== member.userId) {
      socket.emit("server_error", {
        message: "Only the group leader can update trip state.",
      });

      return;
    }

    if (payload.destination !== undefined) {
      group.destination =
        payload.destination || null;
    }

    if (payload.route !== undefined) {
      group.route =
        payload.route || null;
    }

    if (payload.alternatives !== undefined) {
      group.alternatives =
        Array.isArray(payload.alternatives)
          ? payload.alternatives
          : [];
    }

    if (payload.stops !== undefined) {
      group.stops =
        Array.isArray(payload.stops)
          ? payload.stops
          : [];
    }

    emitGroupState(group);
  });

  /*
  |--------------------------------------------------------------------------
  | Leave group
  |--------------------------------------------------------------------------
  */

  socket.on("leave_group", () => {
    const group = getGroupFromSocket(socket);

    if (!group) return;

    const userId = socket.data.userId;

    if (!userId) return;

    const member = group.members.get(userId);

    if (member) {
      group.members.delete(userId);
    }

    socket.leave(group.code);

    socket.data.groupCode = null;
    socket.data.userId = null;

    /*
     * If the leader leaves, choose another connected member.
     */

    if (group.leaderId === userId) {
      const nextLeader =
        Array.from(group.members.values())
          .find((m) => m.connected);

      if (nextLeader) {
        group.leaderId = nextLeader.userId;

        for (const m of group.members.values()) {
          m.isLeader =
            m.userId === group.leaderId;
        }
      }
    }

    /*
     * If nobody remains, delete the group.
     */

    if (group.members.size === 0) {
      groups.delete(group.code);
    } else {
      emitGroupState(group);
    }
  });

  /*
  |--------------------------------------------------------------------------
  | Disconnect
  |--------------------------------------------------------------------------
  |
  | IMPORTANT:
  |
  | Do NOT delete the rider immediately.
  |
  | Their last known location stays visible.
  | lastSeen tells the UI when they were last connected.
  |
  */

  socket.on("disconnect", (reason) => {
    console.log(
      `[socket] disconnected ${socket.id}: ${reason}`
    );

    const group = getGroupFromSocket(socket);

    if (!group) return;

    const userId = socket.data.userId;

    if (!userId) return;

    const member = group.members.get(userId);

    if (!member) return;

    /*
     * Make sure an old socket does not mark a newer
     * reconnect as offline.
     */

    if (member.socketId !== socket.id) {
      return;
    }

    member.connected = false;

    /*
     * Preserve lastSeen.
     *
     * Do NOT set it to null.
     * It represents the last successful update.
     */

    if (!member.lastSeen) {
      member.lastSeen = now();
    }

    member.socketId = null;

    /*
     * Broadcast offline state.
     */

    emitGroupState(group);

    console.log(
      `[offline] ${member.name} (${member.userId}) in ${group.code}`
    );
  });
});

/*
|--------------------------------------------------------------------------
| Periodic cleanup
|--------------------------------------------------------------------------
|
| We keep disconnected riders for a while so that temporary
| network loss does not destroy the group state.
|
| After 30 minutes of no activity, remove them.
|
*/

const OFFLINE_MEMBER_TTL = 30 * 60 * 1000;

setInterval(() => {
  const current = now();

  for (const [code, group] of groups.entries()) {
    for (const [userId, member] of group.members.entries()) {
      if (
        !member.connected &&
        member.lastSeen &&
        current - member.lastSeen >
          OFFLINE_MEMBER_TTL
      ) {
        /*
         * Don't remove the leader if possible.
         * Transfer leadership first.
         */

        if (group.leaderId === userId) {
          const replacement =
            Array.from(group.members.values())
              .find(
                (m) =>
                  m.userId !== userId &&
                  m.connected
              );

          if (replacement) {
            group.leaderId =
              replacement.userId;

            for (const m of group.members.values()) {
              m.isLeader =
                m.userId === group.leaderId;
            }
          }
        }

        group.members.delete(userId);

        console.log(
          `[cleanup] removed stale rider ${userId} from ${code}`
        );
      }
    }

    /*
     * Delete empty groups.
     */

    if (group.members.size === 0) {
      groups.delete(code);
      continue;
    }

    emitGroupState(group);
  }
}, 60 * 1000);

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

server.listen(PORT, () => {
  console.log(
    `Ride Tracker server running on port ${PORT}`
  );
});