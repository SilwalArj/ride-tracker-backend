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
// GROUP STORAGE
// ============================================================

const groups = {};

// ============================================================
// HELPERS
// ============================================================

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

// ============================================================
// SOCKET
// ============================================================

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ==========================================================
  // JOIN GROUP
  // ==========================================================

  socket.on("joinGroup", (data) => {
    const {
      groupCode,
      userId,
      userName,
    } = data;

    if (!groupCode || !userId || !userName) {
      return;
    }

    const group = getGroup(groupCode);

    socket.join(groupCode);

    // Remove duplicate user
    group.members = group.members.filter(
      (user) => user.userId !== userId
    );

    group.members.push({
      socketId: socket.id,
      userId,
      userName,
      lat: null,
      lng: null,
      heading: 0,
    });

    console.log(
      `${userName} joined ${groupCode}`
    );

    // Send current members
    io.to(groupCode).emit("groupMembers", {
      members: group.members,
    });

    // Notify everyone
    io.to(groupCode).emit("userJoined", {
      userId,
      userName,
    });

    // Send EXISTING trip plan specifically to the
    // rider who just joined.
    if (group.tripPlan) {
      socket.emit(
        "tripPlanUpdated",
        group.tripPlan
      );
    if (group.sos) {
     socket.emit(
      "receiveSOS",
      group.sos
    );
  }
      console.log(
        `Sent existing trip plan to ${userName}`
      );
    }
  });


  // ==========================================================
  // LIVE LOCATION
  // ==========================================================

  socket.on("sendLocation", (data) => {
    const {
      groupCode,
      userId,
      userName,
      lat,
      lng,
      heading,
    } = data;

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    const member = group.members.find(
      (user) => user.userId === userId
    );

    if (member) {
      member.lat = lat;
      member.lng = lng;
      member.heading = heading ?? 0;
    }

    socket
      .to(groupCode)
      .emit("receiveLocation", data);

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
    const {
      groupCode,
      start,
      end,
      routePoints,
      distance,
      duration,
      stops,
    } = data;

    const group = getGroup(groupCode);

    group.tripPlan = {
      userId: data.userId,
      userName: data.userName,
      start,
      end,
      routePoints: routePoints || [],
      distance: distance || 0,
      duration: duration || 0,
      stops: stops || [],
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
    const { groupCode } = data;

    const group = groups[groupCode];

    if (!group) {
      return;
    }

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
    const group = getGroup(data.groupCode);

    group.sos = {
      userId: data.userId,
      userName: data.userName,
      lat: data.lat,
      lng: data.lng,
      timestamp: Date.now(),
    };

    console.log(
      "SOS:",
      data.userName,
      data.groupCode,
      data.lat,
      data.lng
    );

    io.to(data.groupCode).emit(
      "receiveSOS",
      group.sos
    );
  });

  // ==========================================================
  // CLEAR SOS
  // ==========================================================

  socket.on("clearSOS", (data) => {
    const group = groups[data.groupCode];

    if (!group) {
      return;
    }

    group.sos = null;

    io.to(data.groupCode).emit("sosCleared", {
      userId: data.userId,
    });

    console.log(
      `SOS CLEARED: ${data.groupCode}`
    );
  });

  // ==========================================================
  // LEAVE GROUP
  // ==========================================================

  socket.on("leaveGroup", (data) => {
    const {
      groupCode,
      userId,
      userName,
    } = data;

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    group.members = group.members.filter(
      (user) => user.userId !== userId
    );

    socket.leave(groupCode);

    io.to(groupCode).emit(
      "groupMembers",
      {
        members: group.members,
      }
    );

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

    if (group.members.length === 0) {
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

    for (const groupCode in groups) {
      const group = groups[groupCode];

      const user = group.members.find(
        (member) =>
          member.socketId === socket.id
      );

      if (!user) {
        continue;
      }

      group.members =
        group.members.filter(
          (member) =>
            member.socketId !== socket.id
        );

      io.to(groupCode).emit(
        "groupMembers",
        {
          members: group.members,
        }
      );

      io.to(groupCode).emit(
        "userLeft",
        {
          userId: user.userId,
          userName: user.userName,
        }
      );

      console.log(
        `${user.userName} left ${groupCode}`
      );
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

server.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});