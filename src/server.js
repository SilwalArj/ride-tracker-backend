require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// 🔐 Middleware
app.use(cors());
app.use(express.json());

// 🧠 Connect MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.log("❌ DB ERROR:", err));

// 🌐 Basic route
app.get("/", (req, res) => {
  res.send("Ride / Trek Tracker Backend Running");
});

// 🔌 Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: "*", // change later in production
    methods: ["GET", "POST"]
  }
});

// 🧠 In-memory group storage (for now)
const groups = {};

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  socket.on("joinGroup", (groupCode) => {
    socket.join(groupCode);

    if (!groups[groupCode]) {
      groups[groupCode] = {};
    }

    groups[groupCode][socket.id] = {
      userId: socket.id,
      lat: null,
      lng: null
    };

    console.log(`👥 User joined group: ${groupCode}`);
  });

  socket.on("sendLocation", (data) => {
    const { groupCode, userId, lat, lng } = data;

    if (groups[groupCode] && groups[groupCode][socket.id]) {
      groups[groupCode][socket.id] = { userId, lat, lng };
    }

    socket.to(groupCode).emit("receiveLocation", {
      userId,
      lat,
      lng
    });
  });

  socket.on("disconnect", () => {
    console.log(" User disconnected:", socket.id);

    // remove from all groups
    for (const groupCode in groups) {
      if (groups[groupCode][socket.id]) {
        delete groups[groupCode][socket.id];
      }
    }
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});