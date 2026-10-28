import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { validateDatabaseEnvironment } from '../../config/environment';
import { createDatabaseOptions } from './database.options';

export default new DataSource(createDatabaseOptions(validateDatabaseEnvironment(process.env)));
