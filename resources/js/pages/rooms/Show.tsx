import React, { useState, useEffect, useRef } from 'react';
import YouTube from 'react-youtube';
import axios from 'axios';
import Pusher from 'pusher-js';

export default function Watch({ room }) {
  const [videoId] = useState(new URL(room.youtube_url).searchParams.get('v'));
  const [player, setPlayer] = useState(null);

  useEffect(() => {
    const pusher = new Pusher(process.env.MIX_PUSHER_APP_KEY, {
      cluster: process.env.MIX_PUSHER_APP_CLUSTER,
      authEndpoint: '/broadcasting/auth',
    });
    const channel = pusher.subscribe(`private-room.${room.code}`);
    channel.bind('App\Events\VideoSync', ({ payload }) => {
      const { event, time } = payload;
      if (!player) return;
      if (event === 'play') player.playVideo();
      if (event === 'pause') player.pauseVideo();
      if (event === 'seek') player.seekTo(time, true);
    });
    return () => pusher.disconnect();
  }, [player]);

  const onReady = e => setPlayer(e.target);
  const sync = (event, time = null) =>
    axios.post(`/api/rooms/${room.code}/sync`, { event, time });

  return (
    <div className="p-4">
      <p>Room Code: <strong>{room.code}</strong></p>
      <YouTube
        videoId={videoId}
        onReady={onReady}
        onPlay={() => sync('play')}
        onPause={() => sync('pause')}
        onStateChange={e => e.data === 3 && sync('seek', e.target.getCurrentTime())}
      />
    </div>
  );
}
