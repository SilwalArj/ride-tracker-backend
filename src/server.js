const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 5000;

/*
groups = {
  ABC123: {
    leaderUserId: "...",

    members: [
      {
        socketId,
        userId,
        userName,
        groupType,
        lat,
        lng,
        heading,
        lastSeen
      }
    ],

    tripPlan: {
      plannedByUserId,
      plannedByUserName,
      groupType,
      startPlace,
      endPlace,
      start,
      destination,
      routePoints,
      routeDistanceMeters,
      routeDurationSeconds,
      updatedAt
    },

    waypoints: [
      {
        id,
        name,
        type,
        lat,
        lng
      }
    ],

    activeSOS: {
      userId,
      userName,
      lat,
      lng,
      createdAt
    }
  }
}
*/

const groups = {};

// =====================================================
// HELPERS
// =====================================================

function getOrCreateGroup(groupCode) {
  if (!groups[groupCode]) {
    groups[groupCode] = {
      leaderUserId: null,
      members: [],
      tripPlan: null,
      waypoints: [],
      activeSOS: null,
    };
  }

  return groups[groupCode];
}

function getPublicMembers(group) {
  return group.members.map((member) => ({
    userId: member.userId,
    userName: member.userName,
    groupType: member.groupType,
    lat: member.lat,
    lng: member.lng,
    heading: member.heading,
    lastSeen: member.lastSeen,
  }));
}

function broadcastMembers(groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  io.to(groupCode).emit("groupMembers", {
    members: getPublicMembers(group),
  });
}

function broadcastGroupInfo(groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  io.to(groupCode).emit("groupInfo", {
    groupCode,
    leaderUserId: group.leaderUserId,
  });
}

function sendExistingLocations(socket, groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  const locations = group.members
    .filter(
      (member) =>
        member.lat !== null &&
        member.lng !== null
    )
    .map((member) => ({
      userId: member.userId,
      userName: member.userName,
      groupType: member.groupType,
      lat: member.lat,
      lng: member.lng,
      heading: member.heading ?? 0,
      lastSeen: member.lastSeen,
    }));

  socket.emit("groupLocations", {
    locations,
  });
}

function removeSocketFromGroup(socket, groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  const index = group.members.findIndex(
    (member) =>
      member.socketId === socket.id
  );

  if (index === -1) return;

  const removedUser =
    group.members[index];

  group.members.splice(index, 1);

  // Elect a new leader if leader left.
  if (
    removedUser.userId ===
    group.leaderUserId
  ) {
    group.leaderUserId =
      group.members.length > 0
        ? group.members[0].userId
        : null;
  }

  socket.leave(groupCode);

  broadcastMembers(groupCode);
  broadcastGroupInfo(groupCode);

  io.to(groupCode).emit(
    "userLeft",
    {
      userId:
        removedUser.userId,
      userName:
        removedUser.userName,
    }
  );

  console.log(
    `${removedUser.userName} left ${groupCode}`
  );

  if (group.members.length === 0) {
    delete groups[groupCode];

    console.log(
      `Group ${groupCode} removed`
    );
  }
}

// =====================================================
// SOCKET
// =====================================================

io.on("connection", (socket) => {
  console.log(
    "User connected:",
    socket.id
  );

  // ===================================================
  // JOIN GROUP
  // ===================================================

  socket.on(
    "joinGroup",
    (data) => {
      const {
        groupCode,
        userId,
        userName,
        groupType,
      } = data;

      if (
        !groupCode ||
        !userId ||
        !userName
      ) {
        console.log(
          "Invalid joinGroup data:",
          data
        );
        return;
      }

      const group =
        getOrCreateGroup(groupCode);

      // First rider becomes leader.
      if (!group.leaderUserId) {
        group.leaderUserId = userId;
      }

      socket.join(groupCode);

      socket.data.groupCode =
        groupCode;

      socket.data.userId =
        userId;

      // Remove stale duplicate user.
      group.members =
        group.members.filter(
          (member) =>
            member.userId !== userId
        );

      group.members.push({
        socketId: socket.id,
        userId,
        userName,
        groupType:
          groupType ?? "bike",
        lat: null,
        lng: null,
        heading: 0,
        lastSeen: null,
      });

      console.log(
        `${userName} joined ${groupCode}`
      );

      console.log(
        "Leader:",
        group.leaderUserId
      );

      // Send group info to joining user.
      socket.emit(
        "groupInfo",
        {
          groupCode,
          leaderUserId:
            group.leaderUserId,
          isLeader:
            group.leaderUserId ===
            userId,
        }
      );

      socket.emit(
        "groupCreated",
        {
          groupCode,
        }
      );

      // Sync all members.
      broadcastMembers(
        groupCode
      );

      broadcastGroupInfo(
        groupCode
      );

      // Notify existing riders.
      socket
        .to(groupCode)
        .emit(
          "userJoined",
          {
            userId,
            userName,
          }
        );

      // Send existing rider locations.
      sendExistingLocations(
        socket,
        groupCode
      );

      // Send shared trip plan.
      if (group.tripPlan) {
        socket.emit(
          "tripPlanUpdated",
          group.tripPlan
        );
      }

      // Send waypoints.
      socket.emit(
        "waypointsUpdated",
        {
          waypoints:
            group.waypoints,
        }
      );

      // Send active SOS.
      if (group.activeSOS) {
        socket.emit(
          "activeSOS",
          group.activeSOS
        );
      }
    }
  );

  // ===================================================
  // LIVE LOCATION
  // ===================================================

  socket.on(
    "sendLocation",
    (data) => {
      const {
        groupCode,
        userId,
        userName,
        groupType,
        lat,
        lng,
        heading,
      } = data;

      const group =
        groups[groupCode];

      if (!group) return;

      const member =
        group.members.find(
          (user) =>
            user.userId === userId
        );

      if (member) {
        member.lat = lat;
        member.lng = lng;

        member.heading =
          typeof heading === "number"
            ? heading
            : 0;

        member.lastSeen =
          new Date().toISOString();

        if (groupType) {
          member.groupType =
            groupType;
        }
      }

      console.log(
        "SEND LOCATION:",
        userName,
        groupCode,
        lat,
        lng,
        heading
      );

      io.to(groupCode).emit(
        "receiveLocation",
        {
          groupCode,
          userId,
          userName,
          groupType,
          lat,
          lng,
          heading:
            typeof heading === "number"
              ? heading
              : 0,
          lastSeen:
            member?.lastSeen ??
            null,
        }
      );
    }
  );

  // ===================================================
  // SHARED TRIP PLAN
  // ===================================================

  socket.on(
    "setTripPlan",
    (data) => {
      const {
        groupCode,
        userId,
        userName,
        groupType,
        startPlace,
        endPlace,
        start,
        destination,
        routePoints,
        routeDistanceMeters,
        routeDurationSeconds,
      } = data;

      const group =
        groups[groupCode];

      if (!group) return;

      // Only leader controls shared route.
      if (
        group.leaderUserId !==
        userId
      ) {
        socket.emit(
          "tripPlanError",
          {
            message:
              "Only the group leader can update the shared route.",
          }
        );

        return;
      }

      group.tripPlan = {
        plannedByUserId:
          userId,

        plannedByUserName:
          userName,

        groupType:
          groupType ?? "bike",

        startPlace:
          startPlace ?? "",

        endPlace:
          endPlace ?? "",

        start:
          start ?? null,

        destination:
          destination ?? null,

        routePoints:
          Array.isArray(routePoints)
            ? routePoints
            : [],

        routeDistanceMeters:
          routeDistanceMeters ??
          0,

        routeDurationSeconds:
          routeDurationSeconds ??
          0,

        updatedAt:
          new Date().toISOString(),
      };

      console.log(
        "TRIP PLAN UPDATED:",
        groupCode
      );

      io.to(groupCode).emit(
        "tripPlanUpdated",
        group.tripPlan
      );
    }
  );

  // ===================================================
  // WAYPOINTS
  // ===================================================

  socket.on(
    "setWaypoints",
    (data) => {
      const {
        groupCode,
        userId,
        waypoints,
      } = data;

      const group =
        groups[groupCode];

      if (!group) return;

      if (
        group.leaderUserId !==
        userId
      ) {
        socket.emit(
          "waypointError",
          {
            message:
              "Only the group leader can change waypoints.",
          }
        );

        return;
      }

      group.waypoints =
        Array.isArray(waypoints)
          ? waypoints
          : [];

      console.log(
        "WAYPOINTS UPDATED:",
        groupCode,
        group.waypoints.length
      );

      io.to(groupCode).emit(
        "waypointsUpdated",
        {
          waypoints:
            group.waypoints,
        }
      );
    }
  );

  // ===================================================
  // CLEAR SHARED TRIP PLAN
  // ===================================================

  socket.on(
    "clearTripPlan",
    (data) => {
      const {
        groupCode,
        userId,
      } = data;

      const group =
        groups[groupCode];

      if (!group) return;

      if (
        group.leaderUserId !==
        userId
      ) {
        return;
      }

      group.tripPlan = null;
      group.waypoints = [];

      io.to(groupCode).emit(
        "tripPlanCleared"
      );

      io.to(groupCode).emit(
        "waypointsUpdated",
        {
          waypoints: [],
        }
      );
    }
  );

  // ===================================================
  // SOS
  // ===================================================

  socket.on(
    "sendSOS",
    (data) => {
      const {
        groupCode,
        userId,
        userName,
        lat,
        lng,
      } = data;

      const group =
        groups[groupCode];

      if (!group) return;

      group.activeSOS = {
        userId,
        userName,
        lat,
        lng,
        createdAt:
          new Date().toISOString(),
      };

      console.log(
        `SOS FROM ${userName} IN ${groupCode}`
      );

      io.to(groupCode).emit(
        "receiveSOS",
        group.activeSOS
      );
    }
  );

  // ===================================================
  // RESOLVE SOS
  // ===================================================

  socket.on(
    "resolveSOS",
    (data) => {
      const {
        groupCode,
        userId,
      } = data;

      const group =
        groups[groupCode];

      if (!group ||
          !group.activeSOS) {
        return;
      }

      const isSender =
        group.activeSOS.userId ===
        userId;

      const isLeader =
        group.leaderUserId ===
        userId;

      if (!isSender &&
          !isLeader) {
        return;
      }

      const resolvedUser =
        group.activeSOS.userName;

      group.activeSOS = null;

      io.to(groupCode).emit(
        "sosResolved",
        {
          userName:
            resolvedUser,
          resolvedBy:
            userId,
        }
      );

      console.log(
        `SOS RESOLVED IN ${groupCode}`
      );
    }
  );

  // ===================================================
  // SAFETY ALERTS
  // ===================================================

  socket.on(
    "safetyAlert",
    (data) => {
      const {
        groupCode,
      } = data;

      if (!groups[groupCode]) {
        return;
      }

      io.to(groupCode).emit(
        "safetyAlert",
        data
      );
    }
  );

  // ===================================================
  // EXPLICIT LEAVE
  // ===================================================

  socket.on(
    "leaveGroup",
    (data) => {
      const {
        groupCode,
      } = data;

      if (!groupCode) return;

      removeSocketFromGroup(
        socket,
        groupCode
      );
    }
  );

  // ===================================================
  // DISCONNECT
  // ===================================================

  socket.on(
    "disconnect",
    () => {
      console.log(
        "User disconnected:",
        socket.id
      );

      const groupCode =
        socket.data.groupCode;

      if (!groupCode) {
        return;
      }

      removeSocketFromGroup(
        socket,
        groupCode
      );
    }
  );
});

// =====================================================
// TEST ROUTE
// =====================================================

app.get(
  "/",
  (req, res) => {
    res.send(
      "Ride Tracker Backend Running"
    );
  }
);

// =====================================================
// START SERVER
// =====================================================

server.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);