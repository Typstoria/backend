import { ApiProperty } from '@nestjs/swagger';

export class LiveHealthDto {
  /** API process status. */
  status!: 'ok';

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}

export class DatabaseCheckDto {
  /** PostgreSQL connection status. */
  database!: 'up';
}

export class ReadyHealthDto extends LiveHealthDto {
  checks!: DatabaseCheckDto;
}
