require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("  MongoDB connected"))
  .catch((err) => console.log("  DB ERROR:", err));

app.get("/", (req, res) => {
  res.send("Ride / Trek Tracker Backend Running");
});

function generateGroupCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const groups = {};
/*
groups = {
  ABC123: {
    members: {
      socketId: { userId, lat, lng }
    },
    createdAt: Date
  }
}
*/

app.post("/api/group/create", (req, res) => {
  const groupCode = generateGroupCode();

  groups[groupCode] = {
    members: {},
    createdAt: new Date()
  };

  console.log(" Group created:", groupCode);

  res.json({ groupCode });
});

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log(" User connected:", socket.id);

  socket.on("joinGroup", ({ groupCode, userId }) => {
    if (!groups[groupCode]) {
      return socket.emit("errorMessage", "Group not found");
    }

    socket.join(groupCode);

    groups[groupCode].members[socket.id] = {
      userId,
      lat: null,
      lng: null
    };
    
    socket.on("sendSOS", (data) => {
    const { groupCode, userId, userName, lat, lng } = data;

    console.log(`🚨 SOS from ${userName}`);

    socket.to(groupCode).emit("receiveSOS", {
      userId,
      userName,
      lat,
      lng
    });
  });
    console.log(`👥 ${userId} joined group: ${groupCode}`);
  });

  socket.on("sendLocation", (data) => {
    const { groupCode, userId, lat, lng } = data;

    if (!groups[groupCode]) return;

    groups[groupCode].members[socket.id] = {
      userId,
      lat,
      lng
    };

    socket.to(groupCode).emit("receiveLocation", {
      userId,
      userName: data.userName,
      lat,
      lng
    });
  });

  socket.on("disconnect", () => {
    console.log(" User disconnected:", socket.id);

    for (const groupCode in groups) {
      if (groups[groupCode].members[socket.id]) {
        delete groups[groupCode].members[socket.id];
      }
    }
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
});