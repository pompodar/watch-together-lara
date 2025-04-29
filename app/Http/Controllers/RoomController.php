<?php

namespace App\Http\Controllers;

use App\Events\VideoSync;
use App\Models\Room;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Support\Str as SupportStr;
use Illuminate\Support\Facades\Validator;
use Inertia\Inertia;
use App\Events\UserStartedEvent;
use App\Events\UserJoinedEvent;
use App\Events\RoomSyncEvent;
use App\Events\WebRTCSignalEvent;

class RoomController extends Controller
{
    // Show creation form
    public function create()
    {
        return Inertia::render('CreateRoom');
    }

    // Handle form submission
    public function storeWeb(Request $request)
    {
        $request->validate(['youtube_url' => 'required|url']);
        $name = Str::upper(Str::random(6));
        $room = Room::create([
            'name' => $name,
            'slug' => $name,
            'youtube_video_id' => $request->youtube_url,
        ]);
        return redirect()->route('rooms.show', ['name' => $name]);
    }

    // Render watch page
    public function show($name)
    {
        $room = Room::where('name', $name)->firstOrFail();
        return Inertia::render('Watch', ['room' => $room]);
    }

    public function sync(Request $request, $name)
    {
        $payload = $request->only(['event', 'time']);
        $source = $request->input('source', 'unknown-source');

        try {
            // Create the event
            $event = new \App\Events\VideoSync($name, $payload, $source);

            // Broadcast the event - use event() helper for more direct broadcasting
            event($event);

            // Alternative direct broadcast to ensure it's working
            $pusher = new \Pusher\Pusher(
                env('PUSHER_APP_KEY'),
                env('PUSHER_APP_SECRET'),
                env('PUSHER_APP_ID'),
                [
                    'cluster' => env('PUSHER_APP_CLUSTER'),
                    'useTLS' => true,
                ]
            );

            $channelName = 'public-room.' . $name;
            $eventName = 'sync';
            $data = [
                'payload' => $payload,
                'room_name' => $name,
                'source' => $source
            ];

            // Direct trigger to Pusher
            $pusher->trigger($channelName, $eventName, $data);

            return response()->json([
                'success' => true,
                'message' => 'Sync event broadcast successfully',
                'payload' => $payload,
                'room_name' => $name,
                'source' => $source
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to broadcast sync event: ' . $e->getMessage()
            ], 500);
        }
    }

    public function userStarted(Request $request, $name)
    {
        $source = $request->input('source', 'unknown-source');

        try {
            // Create the event
            $event = new \App\Events\UserStartedEvent($name, $source);

            // Broadcast the event - use event() helper for more direct broadcasting
            event($event);

            // Alternative direct broadcast to ensure it's working
            $pusher = new \Pusher\Pusher(
                env('PUSHER_APP_KEY'),
                env('PUSHER_APP_SECRET'),
                env('PUSHER_APP_ID'),
                [
                    'cluster' => env('PUSHER_APP_CLUSTER'),
                    'useTLS' => true,
                ]
            );

            $channelName = 'public-room-users-started.' . $name;
            $eventName = 'user-started';
            $data = [
                'room_name' => $name,
                'source' => $source
            ];

            // Direct trigger to Pusher
            $pusher->trigger($channelName, $eventName, $data);

            return response()->json([
                'success' => true,
                'message' => 'Sync event broadcast successfully',
                'room_name' => $name,
                'source' => $source
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to broadcast sync event: ' . $e->getMessage()
            ], 500);
        }
    }

    public function userJoined(Request $request, $name)
    {
        $source = $request->input('source', 'unknown-source');

        try {
            // Create the event
            $event = new \App\Events\UserJoinedEvent($name, $source);

            // Broadcast the event - use event() helper for more direct broadcasting
            event($event);

            // Alternative direct broadcast to ensure it's working
            $pusher = new \Pusher\Pusher(
                env('PUSHER_APP_KEY'),
                env('PUSHER_APP_SECRET'),
                env('PUSHER_APP_ID'),
                [
                    'cluster' => env('PUSHER_APP_CLUSTER'),
                    'useTLS' => true,
                ]
            );

            $channelName = 'public-room-users-joined.' . $name;
            $eventName = 'user-joined';
            $data = [
                'room_name' => $name,
                'source' => $source
            ];

            // Direct trigger to Pusher
            $pusher->trigger($channelName, $eventName, $data);

            return response()->json([
                'success' => true,
                'message' => 'Sync event broadcast successfully',
                'room_name' => $name,
                'source' => $source
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to broadcast sync event: ' . $e->getMessage()
            ], 500);
        }
    }

    public function getUsers(Room $room)
    {
        $users = \App\Models\User::all()->pluck('id')->toArray();

        return response()->json(['users' => $users]);
    }

    /**
     * Relay WebRTC signaling messages.
     */
    public function webrtcSignal(Request $request, string $name)
    {
        // Validate the basic structure, specific 'data' validation depends on 'type'
        // $validator = Validator::make($request->all(), [
        //     'type' => 'required|string|in:offer,answer,ice-candidate',
        //     'data' => 'required|array', // Could be more specific if needed
        //     'source' => 'required|string|max:255',
        //     'target' => 'required|string|max:255',
        // ]);

        // if ($validator->fails()) {
        //     return response()->json(['errors' => $validator->errors()], 422);
        // }

        // $signalData = $validator->validated();

        $signalData = $request->all();

        try {
            // Create the event
            $event = new \App\Events\WebRTCSignalEvent($name, $signalData);

            // Broadcast the event - use event() helper for more direct broadcasting
            event($event);

            // Alternative direct broadcast to ensure it's working
            $pusher = new \Pusher\Pusher(
                env('PUSHER_APP_KEY'),
                env('PUSHER_APP_SECRET'),
                env('PUSHER_APP_ID'),
                [
                    'cluster' => env('PUSHER_APP_CLUSTER'),
                    'useTLS' => true,
                ]
            );

            $channelName = 'public-room-webrtc.' . $name;
            $eventName = 'signal';
            $data = [
                'room_name' => $name,
                'signal' => $signalData
            ];

            // Direct trigger to Pusher
            $pusher->trigger($channelName, $eventName, $data);

            return response()->json([
                'success' => true,
                'message' => 'Sync event broadcast successfully',
                'room_name' => $name,
                'target' => $signalData['target'] ?? null,
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to broadcast sync event: ' . $e->getMessage()
            ], 500);
        }

        // Broadcast the signal to others on the WebRTC channel
        // The frontend client will filter based on the 'target' field
        //   broadcast(new WebRTCSignalEvent($name, $signalData))->toOthers();

        return response()->json(['status' => 'WebRTC signal relayed.']);
    }

    // --- Optional: Add a method for user leaving ---
    // This would likely be called via JavaScript's `beforeunload` or `unload` events,
    // or ideally handled automatically if using Laravel Echo Presence Channels.

    // public function userLeft(Request $request, string $roomName): JsonResponse
    // {
    //     $sourceId = $request->input('source');
    //     if (!$sourceId) {
    //        return response()->json(['error' => 'Source ID required.'], 400);
    //     }

    //     $cacheKey = self::CACHE_KEY_PREFIX . $roomName;
    //     $users = Cache::get($cacheKey, []);

    //     // Remove the user
    //     $users = array_filter($users, fn($user) => $user !== $sourceId);

    //     Cache::put($cacheKey, array_values($users), self::CACHE_TTL); // Re-index array

    //     // Optionally broadcast a 'user-left' event
    //     // broadcast(new UserLeftRoomEvent($roomName, $sourceId))->toOthers();

    //     return response()->json(['status' => 'User removed from room list.']);
    // }
}
