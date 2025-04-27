import React, { useState } from 'react';
import { router as Inertia } from '@inertiajs/react';

export default function CreateRoom() {
  const [url, setUrl] = useState('');
  const handleSubmit = (e) => {
    e.preventDefault();
    Inertia.post(route('rooms.store'), { youtube_url: url });
  };
  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-2xl mb-4">Create a Watch Room</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="Enter YouTube URL"
          className="border p-2 rounded"
          required
        />
        <button type="submit" className="bg-blue-600 text-white py-2 rounded">
          Create Room
        </button>
      </form>
    </div>
  );
}
