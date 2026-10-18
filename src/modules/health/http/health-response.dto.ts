import { ApiProperty } from '@nestjs/swagger';

export class LiveHealthDto {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}

export class DatabaseCheckDto {
  @ApiProperty({ enum: ['up'], example: 'up' })
  database!: 'up';
}

export class ReadyHealthDto extends LiveHealthDto {
  @ApiProperty({ type: DatabaseCheckDto })
  checks!: DatabaseCheckDto;
}
