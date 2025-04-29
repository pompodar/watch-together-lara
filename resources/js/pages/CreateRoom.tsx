import React, { useState, FormEvent } from 'react';
import { router as Inertia } from '@inertiajs/react';
import AppLayout from '@/layouts/app-layout';
import { Head } from '@inertiajs/react';
import { type BreadcrumbItem } from '@/types';
import { Youtube } from 'lucide-react';

const breadcrumbs: BreadcrumbItem[] = [
  { title: "Create Room", href: `/rooms/create` },
];

export default function CreateRoom() {
  const [url, setUrl] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    Inertia.post(route('rooms.store'), { youtube_url: url });
  };

  return (
    <AppLayout breadcrumbs={breadcrumbs}>
      <Head title="Create Watch Room" />

      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="w-full max-w-lg bg-white rounded-2xl shadow-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center space-x-3 px-6 py-4 bg-yellow-600">
            <Youtube className="w-6 h-6 text-white" />
            <h1 className="text-white text-2xl font-semibold">New Watch Room</h1>
          </div>

          {/* Body */}
          <div className="p-6">
            <p className="mb-4 text-yellow-600">
              Paste a YouTube video link to create a synchronized watch room.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="youtubeUrl" className="block text-sm font-medium text-indigo-400 mb-1">
                  YouTube URL
                </label>
                <input
                  id="youtubeUrl"
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  required
                  className="w-full px-4 py-2 text-yellow-700 border border-yellow-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-400 transition"
                />
              </div>

              <button
                type="submit"
                className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white font-medium rounded-lg shadow-md transition"
              >
                <Youtube className="w-5 h-5" />
                <span>Create Room</span>
              </button>
            </form>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-gray-100 text-center text-sm text-yellow-700">
            © {new Date().getFullYear()} WatchNotAlone
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
