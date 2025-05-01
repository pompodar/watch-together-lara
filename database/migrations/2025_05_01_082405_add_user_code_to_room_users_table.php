<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('room_users', function (Blueprint $table) {
            $table->string('user_code')->nullable()->unique()->after('user_id');
        });
    }

    /**
     * Reverse the migrations.
     */

    public function down(): void
    {
        Schema::table('room_users', function (Blueprint $table) {
            $table->dropColumn('user_code');
        });
    }
};
