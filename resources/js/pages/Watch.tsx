import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { debounce } from 'lodash';
import { Play, Pause, Users, Film, RefreshCw, Video, VideoOff, Mic, MicOff } from 'lucide-react';
import AppLayout from '@/layouts/app-layout';
import { Head } from '@inertiajs/react';
import { type BreadcrumbItem } from '@/types';

interface BufferedPeerConnection extends PeerConnection {
  bufferedCandidates?: RTCIceCandidate[];
}

interface Room {
  name: string;
  youtube_video_id: string;
}

interface SyncEvent {
  payload: { event: 'play' | 'pause' | 'seek'; time?: number };
  source?: string;
}

interface PeerConnection {
  connection: RTCPeerConnection;
  stream: MediaStream | null;
  sourceId: string;
}

interface PeerSignal {
  type: 'offer' | 'answer' | 'ice-candidate';
  data: any;
  source: string;
  target: string;
}

declare global {
  interface Window {
    Pusher: typeof Pusher;
    Echo: Echo<any>;
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

// WebRTC configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

export default function Watch({ room }: { room: Room }) {
  const breadcrumbs: BreadcrumbItem[] = [
    { title: `Room: ${room.name}`, href: `/rooms/${room.name}` },
  ];

  // State & refs
  const [videoId, setVideoId] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncSource] = useState(`client-${Math.random().toString(36).substr(2, 8)}`);
  const [status, setStatus] = useState('Loading YouTube API...');
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(false);
  const [usersStarted, setUsersStarted] = useState(0);
  const [userList, setUserList] = useState<string[]>([]);
  const [seekTime, setSeekTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Video chat state
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peerConnections, setPeerConnections] = useState<Record<string, PeerConnection>>({});
  const [videoChatVisible, setVideoChatVisible] = useState(true);

  const usersInRoom = userList.length;
  const allUsersStarted = usersInRoom > 0 && usersStarted >= usersInRoom;

  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const readyRef = useRef(false);
  const mountedRef = useRef(false);
  const apiLoadedRef = useRef(false);
  const pollerRef = useRef<number | null>(null);

  // Debounced sync for seek only
  const sendSyncEvent = useRef(
    debounce((event: 'play' | 'pause' | 'seek', time?: number) => {
      if (!syncEnabled) return;
      axios.post(`/api/rooms/${room.name}/sync`, { event, time, source: syncSource });
    }, 500)
  ).current;

  // Extract video ID
  useEffect(() => {
    try {
      const u = new URL(room.youtube_video_id);
      setVideoId(u.searchParams.get('v') || room.youtube_video_id);
    } catch {
      setVideoId(room.youtube_video_id);
    }
  }, [room.youtube_video_id]);

  // Load YouTube API
  useEffect(() => {
    if (apiLoadedRef.current) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => {
      apiLoadedRef.current = true;
      setStatus('YouTube API ready');
    };
  }, []);

  // Polling slider
  const startPolling = () => {
    if (pollerRef.current == null) {
      pollerRef.current = window.setInterval(() => {
        if (readyRef.current && playerRef.current) {
          setSeekTime(playerRef.current.getCurrentTime());
        }
      }, 200);
    }
  };
  const stopPolling = () => {
    if (pollerRef.current !== null) {
      clearInterval(pollerRef.current);
      pollerRef.current = null;
    }
  };

  // Initialize player
  useEffect(() => {
    if (
      !apiLoadedRef.current ||
      !videoId ||
      !start ||
      !mountedRef.current ||
      !allUsersStarted ||
      !playerContainerRef.current
    ) {
      return;
    }
    if (playerRef.current) playerRef.current.destroy();

    setStatus('Initializing player...');
    playerRef.current = new window.YT.Player(playerContainerRef.current, {
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,
        rel: 0,
        modestbranding: 1,
        disablekb: 1,
        fs: 0,
        origin: window.location.origin,
      },
      events: {
        onReady: (e: any) => {
          readyRef.current = true;
          setStatus('Player ready');
          setDuration(e.target.getDuration());
        },
        onStateChange: (e: any) => {
          if (syncEnabled) {
            if (e.data === window.YT.PlayerState.PLAYING) sendSyncEvent('play');
            else if (e.data === window.YT.PlayerState.PAUSED) sendSyncEvent('pause');
            else if (e.data === window.YT.PlayerState.BUFFERING)
              sendSyncEvent('seek', playerRef.current.getCurrentTime());
          }
          if (e.data === window.YT.PlayerState.PLAYING) startPolling();
          else stopPolling();
        },
      },
    });
  }, [videoId, start, allUsersStarted]);

  // mount/unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (playerRef.current) playerRef.current.destroy();
      stopPolling();
      // Clean up WebRTC connections
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
      Object.values(peerConnections).forEach(pc => {
        pc.connection.close();
      });
    };
  }, []);

  // Echo setup
    useEffect(() => {
        if (!room.name) return;
        window.Pusher = Pusher;
        Pusher.logToConsole = true;
        window.Echo = new Echo({
            broadcaster: 'pusher',
            key: import.meta.env.VITE_PUSHER_APP_KEY,
            cluster: import.meta.env.VITE_PUSHER_APP_CLUSTER,
            forceTLS: true,
        });
        const chan = window.Echo.channel(`public-room.${room.name}`);
        const chanStarted = window.Echo.channel(`public-room-users-started.${room.name}`);
        const webRTCChannel = window.Echo.channel(`public-room-webrtc.${room.name}`);
        const chanJoined = window.Echo.channel(`public-room-users-joined.${room.name}`);

        chan.listen('.sync', handleSyncEvent);

        chanJoined.listen('.user-joined', (d: any) => {
            console.log("JOINED", d);

            if (!userList.includes(d.source)) setUserList(u => [...u, d.source]);
            console.log(localStream, cameraEnabled, d.source, syncSource, "LOCAL STREAM");

            // If we already have our camera on, send an offer to the new user
            if (localStream && cameraEnabled && d.source !== syncSource) {

                createPeerConnection(d.source);

                alert("New user joined, creating peer connection");
            }
        });

        chanStarted.listen('.user-started', (data) => {
            setUsersStarted(u => u + 1);
        console.log('!!!!!User started:', data);

        });



    // WebRTC signaling
      webRTCChannel.listen('.signal', (data: PeerSignal) => {
        console.log("signal!!!!!", data.signal.target, syncSource);
           if (data.signal.target === syncSource) {
              console.log("caught", data.signal);

        handleWebRTCSignal(data.signal);
       }
    });

      axios.post(`/api/rooms/${room.name}/user-joined`, { source: syncSource })
        .then((data) => {
          console.log('Joined room!!!!', data);
        })
        .catch(err => {
          setError(`Failed to join room: ${err instanceof Error ? err.message : String(err)}`);
        });

    return () => {
      window.Echo.leaveChannel(`public-room.${room.name}`);
      window.Echo.leaveChannel(`public-room-users-started.${room.name}`);
      window.Echo.leaveChannel(`public-room-webrtc.${room.name}`);
    };
  }, [room.name]);

  // Handle sync
  const handleSyncEvent = (d: SyncEvent) => {
    if (d.source === syncSource || !syncEnabled || !readyRef.current) return;
    const { event, time } = d.payload;
    if (event === 'play') playerRef.current.playVideo();
    if (event === 'pause') playerRef.current.pauseVideo();
    if (event === 'seek' && time != null) playerRef.current.seekTo(time, true);
  };

  // Start button
  const sendUserStarted = () => {
    setStart(true);
    axios.post(`/api/rooms/${room.name}/user-started`, { source: syncSource });
  };

  // Manual controls
  const play = () => {
    if (!readyRef.current) return setStatus('Not ready');
    playerRef.current.playVideo();
  };

  const pause = () => {
    if (!readyRef.current) return setStatus('Not ready');
    playerRef.current.pauseVideo();
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    setSeekTime(t);
    if (readyRef.current) playerRef.current.seekTo(t, true);
    if (syncEnabled) sendSyncEvent('seek', t);
  };

  // WebRTC functions
  const toggleCamera = async () => {
    try {
      if (!cameraEnabled) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: micEnabled
        });

        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Create peer connections with all users in the room
          userList.forEach(userId => {
            console.log(userId, syncSource, "userId");

          if (userId !== syncSource) {
            createPeerConnection(userId, stream);
          }
        });

        setCameraEnabled(true);
        setStatus('Camera enabled');
      } else {
        // Stop camera
        if (localStream) {
          localStream.getVideoTracks().forEach(track => {
            track.stop();
          });

          // If mic is still enabled, keep audio tracks
          if (micEnabled && localStream) {
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length > 0) {
              const newStream = new MediaStream(audioTracks);
              setLocalStream(newStream);

              if (localVideoRef.current) {
                localVideoRef.current.srcObject = newStream;
              }

              // Update all peer connections with the new stream
              Object.entries(peerConnections).forEach(([userId, pc]) => {
                updatePeerConnectionStream(userId, newStream);
              });
            } else {
              setLocalStream(null);

              if (localVideoRef.current) {
                localVideoRef.current.srcObject = null;
              }

              // Close all peer connections
              Object.entries(peerConnections).forEach(([userId, pc]) => {
                pc.connection.close();
              });

              setPeerConnections({});
            }
          } else {
            setLocalStream(null);

            if (localVideoRef.current) {
              localVideoRef.current.srcObject = null;
            }

            // Close all peer connections
            Object.entries(peerConnections).forEach(([userId, pc]) => {
              pc.connection.close();
            });

            setPeerConnections({});
          }
        }

        setCameraEnabled(false);
        setStatus('Camera disabled');
      }
    } catch (err) {
      setError(`Failed to access camera: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggleMic = async () => {
    try {
      if (!micEnabled) {
        // If camera is already enabled, just add audio tracks
        if (localStream && cameraEnabled) {
          const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const audioTrack = audioStream.getAudioTracks()[0];

          localStream.addTrack(audioTrack);

          // Update all peer connections with the new track
          Object.entries(peerConnections).forEach(([userId, pc]) => {
            pc.connection.getSenders().forEach(sender => {
              if (sender.track && sender.track.kind === 'audio') {
                sender.replaceTrack(audioTrack);
              } else if (!sender.track || sender.track.kind !== 'audio') {
                pc.connection.addTrack(audioTrack, localStream!);
              }
            });
          });
        } else {
          // Start new audio-only stream
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

          setLocalStream(stream);

          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
          }

          // Create peer connections for audio only
          userList.forEach(userId => {
            if (userId !== syncSource) {
              createPeerConnection(userId, stream);
            }
          });
        }

        setMicEnabled(true);
        setStatus('Microphone enabled');
      } else {
        // Stop microphone
        if (localStream) {
          localStream.getAudioTracks().forEach(track => {
            track.stop();
          });

          // If camera is still enabled, keep video tracks
          if (cameraEnabled && localStream) {
            const videoTracks = localStream.getVideoTracks();
            if (videoTracks.length > 0) {
              const newStream = new MediaStream(videoTracks);
              setLocalStream(newStream);

              if (localVideoRef.current) {
                localVideoRef.current.srcObject = newStream;
              }

              // Update all peer connections with the new stream
              Object.entries(peerConnections).forEach(([userId, pc]) => {
                updatePeerConnectionStream(userId, newStream);
              });
            }
          } else if (!cameraEnabled) {
            setLocalStream(null);

            if (localVideoRef.current) {
              localVideoRef.current.srcObject = null;
            }

            // Close all peer connections
            Object.entries(peerConnections).forEach(([userId, pc]) => {
              pc.connection.close();
            });

            setPeerConnections({});
          }
        }

        setMicEnabled(false);
        setStatus('Microphone disabled');
      }
    } catch (err) {
      setError(`Failed to access microphone: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Create a new peer connection
  const createPeerConnection = async (targetId: string, stream: MediaStream | null = localStream) => {
    try {
      const pc = new RTCPeerConnection(rtcConfig);

      // Add local stream to peer connection
      if (stream) {
        stream.getTracks().forEach(track => {
          pc.addTrack(track, stream);
        });
      }

        console.log(stream, "STREAM");


      // Handle ICE candidates
        pc.onicecandidate = (event) => {
        console.log('ICE candidate:', event.candidate);
        if (event.candidate) {
          sendSignal({
            type: 'ice-candidate',
            data: event.candidate,
            source: syncSource,
            target: targetId
          });
        }
      };

      // Handle remote stream
        pc.ontrack = (event) => {
            console.log('Received remote track:', event.track);

        setPeerConnections(prev => ({
          ...prev,
          [targetId]: {
            ...prev[targetId],
            stream: event.streams[0]
          }
        }));
      };

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendSignal({
        type: 'offer',
        data: offer,
        source: syncSource,
        target: targetId
      });

      setPeerConnections(prev => ({
        ...prev,
        [targetId]: {
          connection: pc,
          stream: null,
          sourceId: targetId
        }
      }));

    } catch (err) {
      setError(`Failed to create peer connection: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Update peer connection with new stream
  const updatePeerConnectionStream = (targetId: string, stream: MediaStream) => {
    const pc = peerConnections[targetId]?.connection;
    if (!pc) return;

    // Remove all existing senders
    const senders = pc.getSenders();
    senders.forEach(sender => {
      pc.removeTrack(sender);
    });

    // Add new tracks
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });
  };

  // Send WebRTC signal via Pusher
    const sendSignal = (signal: PeerSignal) => {
      console.log('sending signal', signal);

      axios.post(`/api/rooms/${room.name}/webrtc-signal`, signal)
          .then((data) => {
            console.log('Signal sent', data);
          })
        .catch(err => {
          setError(`Failed to send WebRTC signal: ${err instanceof Error ? err.message : String(err)}`);
        });
  };

  // Handle incoming WebRTC signals
const handleWebRTCSignal = async (signal: PeerSignal) => {
  const { type, data, source } = signal;

  // Only process signals intended for this client
  if (signal.target !== syncSource) {
    console.log("Ignored signal - not targeted at me");
    return;
  }

                  data.sdp += '\n';


  try {
    switch (type) {
      case 'offer': {
        console.log('Received offer:', data);

        // Create new peer connection if it doesn't exist
        if (!peerConnections[source]) {
          const pc = new RTCPeerConnection(rtcConfig);
          const bufferedCandidates: RTCIceCandidate[] = [];

          // Store buffered ICE candidates temporarily
          (pc as any).bufferedCandidates = [];

          // Add local stream if available
          if (localStream) {
            localStream.getTracks().forEach(track => {
              pc.addTrack(track, localStream);
            });
          }

          // Handle ICE candidates
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              sendSignal({
                type: 'ice-candidate',
                data: event.candidate,
                source: syncSource,
                target: source
              });
            }
          };

          // Handle remote stream
          pc.ontrack = (event) => {
            console.log('Remote track received:', event.track.kind);
            setPeerConnections(prev => ({
              ...prev,
              [source]: {
                ...prev[source],
                stream: event.streams[0]
              }
            }));
          };

          // Set remote description
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data));

            // Process buffered ICE candidates
            while ((pc as any).bufferedCandidates.length > 0) {
              const candidate = (pc as any).bufferedCandidates.shift();
              await pc.addIceCandidate(candidate);
            }
          } catch (err) {
            console.error('Failed to set remote description:', err);
            setError(`SDP Error: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

          // Create answer
          const answer = await pc.createAnswer();

          // Force consistent DTLS roles:
          // Offerer = active, Answerer = passive
          answer.sdp = answer.sdp!.replace(/a=setup:actpass/g, 'a=setup:passive');

          await pc.setLocalDescription(answer);

          // Send answer back
          sendSignal({
            type: 'answer',
            data: answer,
            source: syncSource,
            target: source
          });

          // Save peer connection
          setPeerConnections(prev => ({
            ...prev,
            [source]: {
              connection: pc,
              stream: null,
              sourceId: source
            }
          }));
        } else {
          // Existing connection - just update remote description
          const pc = peerConnections[source].connection;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data));
          } catch (err) {
            console.error('Failed to update existing connection:', err);
          }

          // Create and send answer
          const answer = await pc.createAnswer();
          answer.sdp = answer.sdp!.replace(/a=setup:actpass/g, 'a=setup:passive');
          await pc.setLocalDescription(answer);
          sendSignal({
            type: 'answer',
            data: answer,
            source: syncSource,
            target: source
          });
        }
        break;
      }

      case 'answer': {
        const pc = peerConnections[source]?.connection;
        if (!pc) {
          console.warn('Answer received but no peer connection exists');
          return;
        }

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
        } catch (err) {
          console.error('Failed to set remote answer:', err);
        }
        break;
      }

      case 'ice-candidate': {
        const pc = peerConnections[source]?.connection;
        if (!pc) {
          console.warn('ICE candidate received but no peer connection exists');
          return;
        }

        const candidate = new RTCIceCandidate(data);

        if (pc.remoteDescription) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            console.error('Failed to add ICE candidate:', err);
          }
        } else {
          // Buffer candidate until remote description is set
          if (!(pc as any).bufferedCandidates) {
            (pc as any).bufferedCandidates = [];
          }
          (pc as any).bufferedCandidates.push(candidate);
        }
        break;
      }
    }
  } catch (err) {
    setError(`WebRTC error: ${err instanceof Error ? err.message : String(err)}`);
    console.error('WebRTC error:', err);
  }
};

  return (
    <AppLayout breadcrumbs={breadcrumbs}>
      <Head title="Watch Room" />

      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-5xl w-full bg-white shadow-lg rounded-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <div className="flex items-center space-x-3">
              <Film className="w-6 h-6 text-yellow-600" />
              <h2 className="text-xl font-semibold text-gray-800">Room: {room.name}</h2>
            </div>
            <div className="flex items-center space-x-2">
              <label className="flex items-center space-x-1 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={syncEnabled}
                  onChange={() => setSyncEnabled(!syncEnabled)}
                  className="h-4 w-4 yellow-600 rounded"
                />
                <span>Sync</span>
              </label>
              <label className="flex items-center space-x-1 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={videoChatVisible}
                  onChange={() => setVideoChatVisible(!videoChatVisible)}
                  className="h-4 w-4 yellow-600 rounded"
                />
                <span>Video Chat</span>
              </label>
              <Users className="w-5 h-5 text-yellow-500" />
              <span className="text-sm font-medium text-gray-700">
                {usersStarted}/{usersInRoom}
              </span>
            </div>
          </div>

          <div className="flex">
            {/* Main content */}
            <div className={`${videoChatVisible ? 'w-3/4' : 'w-full'}`}>
              {/* Video or waiting */}
              {allUsersStarted ? (
                <div className="relative bg-black aspect-video">
                  <div
                    ref={playerContainerRef}
                    className="w-full h-full youtube-player-container pointer-events-none"
                  />
                </div>
              ) : (
                <div className="relative bg-black aspect-video flex items-center justify-center">
                  {!start ? (
                    <button
                      onClick={sendUserStarted}
                      className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-xl transition"
                    >
                      Start
                    </button>
                  ) : (
                    <p className="text-white text-lg">Waiting for others…</p>
                  )}
                </div>
              )}

              {/* Status/Error */}
              {status && (
                <div className="px-6 py-2 text-sm text-gray-500">
                  Status: <span className="font-medium">{status}</span>
                </div>
              )}
              {error && <div className="px-6 py-2 text-sm text-red-600">{error}</div>}

              {/* Controls */}
              {allUsersStarted && (
                <div className="px-6 py-4 border-t bg-white flex flex-col space-y-4">
                  <div className="flex items-center justify-center space-x-6">
                    <button onClick={play} className="p-3 bg-indigo-50 rounded-full hover:bg-indigo-100">
                      <Play className="w-6 h-6 text-indigo-600" />
                    </button>
                    <button onClick={pause} className="p-3 bg-indigo-50 rounded-full hover:bg-indigo-100">
                      <Pause className="w-6 h-6 text-indigo-600" />
                    </button>
                    <button
                      onClick={() => {
                        setSeekTime(0);
                        readyRef.current && playerRef.current.seekTo(0, true);
                      }}
                      className="p-3 bg-indigo-50 rounded-full hover:bg-indigo-100"
                    >
                      <RefreshCw className="w-6 h-6 text-indigo-600" />
                    </button>
                  </div>
                  <div className="flex items-center space-x-3">
                    <span className="text-xs text-gray-600">{seekTime.toFixed(1)}s</span>
                    <input
                      type="range"
                      min={0}
                      max={duration}
                      step={0.1}
                      value={seekTime}
                      onChange={handleSeekChange}
                      className="flex-1 h-1 rounded-lg appearance-none bg-gray-300 accent-indigo-600 cursor-pointer"
                    />
                    <span className="text-xs text-gray-600">{duration.toFixed(1)}s</span>
                  </div>
                </div>
              )}
            </div>

            {/* Video chat sidebar */}
            {videoChatVisible && (
              <div className="w-1/4 border-l bg-gray-50">
                <div className="p-4 border-b">
                  <h3 className="font-medium text-gray-700 mb-3">Video Chat</h3>
                  <div className="flex justify-center space-x-2">
                    <button
                      onClick={toggleCamera}
                      className={`p-2 rounded-full ${cameraEnabled ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-200 text-gray-600'}`}
                      title={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                    >
                      {cameraEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
                    </button>
                    <button
                      onClick={toggleMic}
                      className={`p-2 rounded-full ${micEnabled ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-200 text-gray-600'}`}
                      title={micEnabled ? "Mute microphone" : "Unmute microphone"}
                    >
                      {micEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                {/* Local video preview */}
                <div className="p-2">
                  <div className="aspect-video bg-gray-900 rounded overflow-hidden relative">
                    <video
                      ref={localVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-1 left-1 bg-black bg-opacity-60 text-white text-xs px-2 py-1 rounded">
                      You
                    </div>
                  </div>
                </div>

                {/* Remote peer videos */}
                <div className="p-2 space-y-2 max-h-96 overflow-y-auto">
                  {Object.entries(peerConnections).map(([userId, { stream, sourceId }]) => (
                    <div key={userId} className="aspect-video bg-gray-900 rounded overflow-hidden relative">
                      <video
                        autoPlay
                        playsInline
                        className="w-full h-full object-cover"
                        srcObject={stream || null}
                      />
                      <div className="absolute bottom-1 left-1 bg-black bg-opacity-60 text-white text-xs px-2 py-1 rounded">
                        User {userId.substring(0, 5)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
