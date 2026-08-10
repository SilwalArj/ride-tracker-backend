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

const PORT = process.env.PORT || 3000;

// ============================================================
// IN-MEMORY GROUP STORAGE
// Field-test MVP only. Replace with DB/Redis for production.
// ============================================================

const groups = {};

function getGroup(groupCode) {
  if (!groups[groupCode]) {
    groups[groupCode] = {
      members: [],
      tripPlan: null,
      sos: null,
    };
  }

  return groups[groupCode];
}

function sanitizeMember(member) {
  return {
    userId: member.userId,
    userName: member.userName,
    lat: member.lat,
    lng: member.lng,
    heading: member.heading ?? 0,
    lastSeen: member.lastSeen ?? null,
  };
}

function emitMembers(groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  io.to(groupCode).emit("groupMembers", {
    members: group.members.map(sanitizeMember),
  });
}

// ============================================================
// SOCKET
// ============================================================

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ==========================================================
  // JOIN GROUP
  // ==========================================================

  socket.on("joinGroup", (data) => {
    const groupCode = String(data?.groupCode ?? "").trim();
    const userId = String(data?.userId ?? "").trim();
    const userName = String(data?.userName ?? "").trim();

    if (!groupCode || !userId || !userName) {
      console.log("Invalid joinGroup payload:", data);
      return;
    }

    const group = getGroup(groupCode);

    socket.join(groupCode);

    // Remove an old socket entry for the same user.
    group.members = group.members.filter(
      (member) => member.userId !== userId
    );

    group.members.push({
      socketId: socket.id,
      userId,
      userName,
      lat: null,
      lng: null,
      heading: 0,
      lastSeen: null,
    });

    console.log(`${userName} joined ${groupCode}`);

    emitMembers(groupCode);

    io.to(groupCode).emit("userJoined", {
      userId,
      userName,
    });

    socket.emit("groupJoined", {
      groupCode,
    });

    // Send existing trip to a late joiner.
    if (group.tripPlan) {
      socket.emit("tripPlanUpdated", group.tripPlan);

      console.log(
        `Sent existing trip plan to ${userName}`
      );
    }

    // Send active SOS independently of trip plan.
    if (group.sos) {
      socket.emit("receiveSOS", group.sos);

      console.log(
        `Sent active SOS to ${userName}`
      );
    }
  });

  // ==========================================================
  // LIVE LOCATION
  // ==========================================================

  socket.on("sendLocation", (data) => {
    const groupCode = String(data?.groupCode ?? "").trim();
    const userId = String(data?.userId ?? "").trim();
    const userName = String(data?.userName ?? "").trim();

    const lat = Number(data?.lat);
    const lng = Number(data?.lng);
    const heading = Number(data?.heading ?? 0);

    if (
      !groupCode ||
      !userId ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return;
    }

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    const member = group.members.find(
      (user) => user.userId === userId
    );

    if (!member) {
      console.log(
        `Location ignored: ${userName} is not in group ${groupCode}`
      );

      return;
    }

    member.lat = lat;
    member.lng = lng;
    member.heading = Number.isFinite(heading)
      ? heading
      : 0;

    member.lastSeen = Date.now();

    const locationData = {
      groupCode,
      userId,
      userName,
      lat,
      lng,
      heading: member.heading,
      lastSeen: member.lastSeen,
    };

    // Do not send the location back to the sender.
    socket
      .to(groupCode)
      .emit("receiveLocation", locationData);

    console.log(
      "SEND LOCATION:",
      userName,
      groupCode,
      lat,
      lng
    );
  });

  // ==========================================================
  // TRIP PLAN
  // ==========================================================

  socket.on("broadcastTripPlan", (data) => {
    const groupCode = String(
      data?.groupCode ?? ""
    ).trim();

    if (!groupCode) return;

    const group = getGroup(groupCode);

    group.tripPlan = {
      userId: String(
        data?.userId ?? ""
      ),

      userName: String(
        data?.userName ?? ""
      ),

      start: data?.start ?? null,

      end: data?.end ?? null,

      routePoints: Array.isArray(
        data?.routePoints
      )
        ? data.routePoints
        : [],

      distance: Number(
        data?.distance ?? 0
      ),

      duration: Number(
        data?.duration ?? 0
      ),

      stops: Array.isArray(
        data?.stops
      )
        ? data.stops
        : [],

      updatedAt: Date.now(),
    };

    console.log(
      `TRIP PLAN UPDATED: ${groupCode}`
    );

    io.to(groupCode).emit(
      "tripPlanUpdated",
      group.tripPlan
    );
  });

  // ==========================================================
  // CLEAR TRIP PLAN
  // ==========================================================

  socket.on("clearTripPlan", (data) => {
    const groupCode = String(
      data?.groupCode ?? ""
    ).trim();

    const group = groups[groupCode];

    if (!group) return;

    group.tripPlan = null;

    console.log(
      `TRIP PLAN CLEARED: ${groupCode}`
    );

    io.to(groupCode).emit(
      "tripPlanCleared"
    );
  });

  // ==========================================================
  // SOS
  // ==========================================================

  socket.on("sendSOS", (data) => {
    const groupCode = String(
      data?.groupCode ?? ""
    ).trim();

    if (!groupCode) return;

    const group = getGroup(groupCode);

    const lat = Number(data?.lat);
    const lng = Number(data?.lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return;
    }

    group.sos = {
      userId: String(
        data?.userId ?? ""
      ),

      userName: String(
        data?.userName ?? "Rider"
      ),

      lat,
      lng,

      testMode:
        data?.testMode === true,

      timestamp: Date.now(),
    };

    console.log(
      "SOS:",
      group.sos.userName,
      groupCode,
      lat,
      lng
    );

    io.to(groupCode).emit(
      "receiveSOS",
      group.sos
    );
  });

  // ==========================================================
  // CLEAR SOS
  // ==========================================================

  socket.on("clearSOS", (data) => {
    const groupCode = String(
      data?.groupCode ?? ""
    ).trim();

    const group = groups[groupCode];

    if (!group) return;

    group.sos = null;

    io.to(groupCode).emit(
      "sosCleared",
      {
        userId: String(
          data?.userId ?? ""
        ),
      }
    );

    console.log(
      `SOS CLEARED: ${groupCode}`
    );
  });

  // ==========================================================
  // LEAVE GROUP
  // ==========================================================

  socket.on("leaveGroup", (data) => {
    const groupCode = String(
      data?.groupCode ?? ""
    ).trim();

    const userId = String(
      data?.userId ?? ""
    ).trim();

    const userName = String(
      data?.userName ?? ""
    ).trim();

    const group = groups[groupCode];

    if (!group) return;

    const oldLength =
      group.members.length;

    group.members =
      group.members.filter(
        (member) =>
          member.userId !== userId
      );

    if (
      group.members.length ===
      oldLength
    ) {
      socket.leave(groupCode);
      return;
    }

    socket.leave(groupCode);

    emitMembers(groupCode);

    io.to(groupCode).emit(
      "userLeft",
      {
        userId,
        userName,
      }
    );

    console.log(
      `${userName} left ${groupCode}`
    );

    if (
      group.members.length === 0
    ) {
      delete groups[groupCode];

      console.log(
        `Group ${groupCode} deleted`
      );
    }
  });

  // ==========================================================
  // DISCONNECT
  // ==========================================================

  socket.on("disconnect", () => {
    console.log(
      "User disconnected:",
      socket.id
    );

    for (
      const groupCode of Object.keys(
        groups
      )
    ) {
      const group =
        groups[groupCode];

      const user =
        group.members.find(
          (member) =>
            member.socketId ===
            socket.id
        );

      if (!user) continue;

      group.members =
        group.members.filter(
          (member) =>
            member.socketId !==
            socket.id
        );

      emitMembers(groupCode);

      io.to(groupCode).emit(
        "userLeft",
        {
          userId: user.userId,
          userName: user.userName,
        }
      );

      console.log(
        `${user.userName} disconnected from ${groupCode}`
      );

      if (
        group.members.length === 0
      ) {
        delete groups[groupCode];

        console.log(
          `Group ${groupCode} deleted`
        );
      }
    }
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.send(
    "Ride Tracker Backend Running"
  );
});

// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);