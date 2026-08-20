import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { ALL_MODEL_DEFINITIONS } from './schemas';

const logger = new Logger('DatabaseModule');

/**
 * Wires up the MongoDB connection via Mongoose and registers every
 * collection's schema (SRS §4) via `MongooseModule.forFeature()`. Exports
 * MongooseModule so any feature module can `@InjectModel(...)` these
 * without redeclaring `forFeature()` itself.
 *
 * Mongoose connects asynchronously and buffers commands by default, so
 * Nest's "dependencies initialized" log does NOT mean the connection
 * actually succeeded. We attach explicit event listeners so a real
 * success/failure is visible in the logs at startup.
 *
 * IMPORTANT: listeners must be attached via `onConnectionCreate`, not
 * `connectionFactory`. Internally, @nestjs/mongoose calls
 * `connectionFactory` only *after* it has already awaited
 * `connection.asPromise()` — by then the 'connected' (or 'error') event
 * has already fired and any listener attached in `connectionFactory`
 * misses it forever, so nothing gets logged even though the DB may be
 * connected fine. `onConnectionCreate` runs immediately after the
 * connection object is created, before that await, so listeners are in
 * place in time to catch both outcomes.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('app.mongodb.uri'),
        onConnectionCreate: (connection: Connection) => {
          connection.on('connected', () => {
            logger.log('MongoDB connected successfully');
          });
          connection.on('error', (err: Error) => {
            logger.error(`MongoDB connection error: ${err.message}`, err.stack);
          });
          connection.on('disconnected', () => {
            logger.warn('MongoDB disconnected');
          });
          return connection;
        },
      }),
    }),
    MongooseModule.forFeature(ALL_MODEL_DEFINITIONS),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
