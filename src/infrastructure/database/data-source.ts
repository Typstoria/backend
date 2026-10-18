import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../../config/environment';
import { createDatabaseOptions } from './database.options';

export default new DataSource(createDatabaseOptions(validateEnvironment(process.env)));
